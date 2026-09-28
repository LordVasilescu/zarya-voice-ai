// © 2026 Mathew. All rights reserved.
// ZaryaBot: Discord voice link.
// Listens in a voice channel, transcribes speech via the local Whisper endpoint,
// thinks via the Claude CLI, and speaks replies back via the local cloned voice.
//
// Text commands (any channel the bot can read):
//   !zarya join    - join your VC, listen to EVERYONE, log a consented group memory
//   !zarya leave   - leave the voice channel
//   !zarya reset   - fresh Claude conversation + clear short-term buffer (disk log kept)
//   !zarya forget  - wipe today's transcript log and buffer (privacy escape hatch)
//   !zarya status  - show link status + memory size
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Client, GatewayIntentBits, ChannelType,
} from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, EndBehaviorType,
  createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, StreamType,
} from '@discordjs/voice';
import prism from 'prism-media';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const STATE_FILE = path.join(HERE, 'state.json');
const STT_URL = process.env.ZARYA_STT_URL ?? 'http://127.0.0.1:8765/stt';
const TTS_URL = process.env.ZARYA_TTS_URL ?? 'http://127.0.0.1:8765/tts';
const MODEL = process.env.ZARYA_MODEL ?? 'sonnet';
const MEMORY_DIR = process.env.ZARYA_MEMORY_DIR ?? path.join(HERE, 'voicelog');
const KEEP_AUDIO = process.env.ZARYA_KEEP_AUDIO === '1';
const CONTEXT_LINES = 40; // how many recent lines of group convo to feed the brain
const MIN_PCM_BYTES = 48000 * 2 * 2 * 0.4; // skip blips under ~0.4s
// Whisper hallucinates these on near-silence; drop them.
const HALLUCINATIONS = new Set(['thank you.', 'thanks for watching.', 'you', 'bye.', '.']);
// Only utterances containing the wake word reach the brain. Variants cover
// Whisper's common mishearings of "Zarya".
const WAKE = /\b(zarya|zaria|zara|sarya|saria|zorya)\b/i;

let linkedUserId = null;   // who ran !zarya join (for status display)
let linkedTextChannel = null;
let linkedGuild = null;
let player = null;
const activeSpeakers = new Set(); // user IDs currently being captured (multi-speaker)
let queue = Promise.resolve(); // utterances processed one at a time
const recentConvo = []; // rolling buffer of "Name: text" lines for brain context

function logDir() {
  try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch { /* exists */ }
  return MEMORY_DIR;
}

// Append one spoken line to the permanent group memory and the rolling buffer.
// startMs/endMs are epoch ms of the actual speech window — with per-speaker
// streams this lets the log reconstruct true chronology even when people talk
// over each other (overlapping windows = simultaneous speech / interruptions).
function logLine(userId, name, text, startMs, endMs) {
  const start = new Date(startMs ?? Date.now());
  recentConvo.push(`${name}: ${text}`);
  if (recentConvo.length > CONTEXT_LINES) recentConvo.shift();
  try {
    const day = start.toISOString().slice(0, 10);
    const entry = JSON.stringify({
      start: start.toISOString(),
      durationMs: endMs && startMs ? endMs - startMs : null,
      userId, name, text,
    }) + '\n';
    fs.appendFileSync(path.join(logDir(), `voicelog-${day}.jsonl`), entry);
  } catch (e) {
    console.error('log write error:', e.message);
  }
}

// On startup, reload today's tail so a restart doesn't wipe short-term memory.
function primeBuffer() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(logDir(), `voicelog-${day}.jsonl`);
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-CONTEXT_LINES);
    for (const l of lines) {
      try { const e = JSON.parse(l); recentConvo.push(`${e.name}: ${e.text}`); } catch { /* skip */ }
    }
    console.log(`primed ${recentConvo.length} lines of prior convo from today`);
  } catch { /* ignore */ }
}

const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { sessionId: null };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once('clientReady', () => {
  console.log(`Zarya online as ${client.user.tag}`);
  primeBuffer();
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.content.toLowerCase().startsWith('!zarya')) return;
  const cmd = msg.content.toLowerCase().split(/\s+/)[1] ?? 'status';

  if (cmd === 'join') {
    const vc = msg.member?.voice?.channel;
    if (!vc) { await msg.reply('Get in a voice channel first, choom.'); return; }
    linkedUserId = msg.author.id;
    linkedTextChannel = msg.channel;
    linkedGuild = vc.guild;
    const connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: vc.guild.id,
      adapterCreator: vc.guild.voiceAdapterCreator,
      selfDeaf: false, // we are literally here to listen
    });
    player = createAudioPlayer();
    connection.subscribe(player);
    listen(connection, vc.guild);
    // Consent disclosure — everyone in the channel should see this.
    await msg.channel.send(
      `🎙️ **Zarya is now listening and remembering in __${vc.name}__.**\n` +
      `Heads up: I transcribe what's said here and keep a memory log so I can recall context later for everyone. ` +
      `Raw audio is ${KEEP_AUDIO ? '**kept**' : 'not kept (transcripts only)'}. ` +
      `If you're not cool with that, leave the channel or say so. Say **"Zarya"** in a sentence to talk to me.`,
    );
  } else if (cmd === 'leave') {
    getVoiceConnection(msg.guild.id)?.destroy();
    linkedUserId = null;
    linkedGuild = null;
    activeSpeakers.clear();
    await msg.reply('Unplugged, memory saved. Later, choom.');
  } else if (cmd === 'reset') {
    state.sessionId = null;
    recentConvo.length = 0;
    saveState();
    await msg.reply('Fresh brain, who dis. New conversation (memory log on disk is untouched).');
  } else if (cmd === 'forget') {
    // Privacy escape hatch: wipe today's transcript + buffer.
    recentConvo.length = 0;
    try {
      const day = new Date().toISOString().slice(0, 10);
      const f = path.join(logDir(), `voicelog-${day}.jsonl`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    await msg.reply("Today's voice log wiped. Gone like it never happened.");
  } else {
    await msg.reply(linkedUserId
      ? `Linked, model ${MODEL}, ${recentConvo.length} lines in memory, session ${state.sessionId ? 'active' : 'new'}.`
      : 'Not in a voice channel. `!zarya join` while you are in one.');
  }
});

function listen(connection, guild) {
  const receiver = connection.receiver;
  receiver.speaking.on('start', (userId) => {
    if (activeSpeakers.has(userId)) return; // already capturing this speaker
    activeSpeakers.add(userId);
    const startMs = Date.now();
    // Each user is a SEPARATE stream — overlapping speakers never get mixed,
    // so attribution is exact even when everyone talks at once.
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    opus.pipe(decoder);
    decoder.on('data', (c) => chunks.push(c));
    decoder.on('error', (e) => console.error('decode error:', e.message));
    opus.once('end', () => {
      activeSpeakers.delete(userId);
      const endMs = Date.now() - 900; // subtract the trailing silence window
      const pcm = Buffer.concat(chunks);
      if (pcm.length < MIN_PCM_BYTES) return;
      const name = guild.members.cache.get(userId)?.displayName ?? `user-${userId.slice(-4)}`;
      queue = queue.then(() => handleUtterance(pcm, userId, name, startMs, endMs)).catch(console.error);
    });
  });
}

async function handleUtterance(pcm, userId, displayName, startMs, endMs) {
  const stamp = Date.now();
  const raw = path.join(TMP, `${stamp}.pcm`);
  const wav = path.join(TMP, `${stamp}.wav`);
  fs.writeFileSync(raw, pcm);
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '48000',
      '-ac', '2', '-i', raw, '-ar', '16000', '-ac', '1', wav]);
    const sttRes = await fetch(STT_URL, { method: 'POST', body: fs.readFileSync(wav) });
    if (!sttRes.ok) throw new Error(`stt http ${sttRes.status}`);
    const { text } = await sttRes.json();
    if (!text || HALLUCINATIONS.has(text.toLowerCase())) return;

    // Everyone's lines go into the group memory, wake word or not.
    logLine(userId, displayName, text, startMs, endMs);
    if (KEEP_AUDIO) {
      try {
        fs.copyFileSync(wav, path.join(logDir(), '..', 'audio', `${stamp}_${displayName}.wav`));
      } catch { /* audio dir optional */ }
    }

    if (!WAKE.test(text)) { console.log(`(${displayName}, logged): ${text}`); return; }
    console.log(`heard ${displayName}: ${text}`);
    await linkedTextChannel?.send(`🎙️ **${displayName}:** ${text}`);

    linkedTextChannel?.sendTyping().catch(() => {});
    // Feed recent group conversation as context so she remembers who said what.
    const context = recentConvo.slice(0, -1).join('\n');
    const prompt = context
      ? `Recent voice channel conversation (most recent last):\n${context}\n\n`
        + `${displayName} just addressed you: "${text}"\nRespond to ${displayName}.`
      : `${displayName} addressed you: "${text}"\nRespond to ${displayName}.`;
    let reply = await askClaude(prompt);
    if (!reply) return;
    // MUSIC: lines become "!it" commands for Iron Talon in the text channel.
    const music = [];
    reply = reply.replace(/^\s*MUSIC:\s*(.+)$/gim, (_, c) => { music.push(c.trim()); return ''; });
    for (const m of music.slice(0, 10)) {
      await linkedTextChannel?.send(`!it ${m}`);
    }
    const [spokenPart, ...pubParts] = reply.split(/^-{3}PUBLISH-{3}$/m);
    const spoken = spokenPart.trim();
    const published = pubParts.join('\n').trim();
    if (spoken) {
      logLine(client.user.id, 'Zarya', spoken); // remember her own side too
      await linkedTextChannel?.send(`🔊 **Zarya:** ${spoken}`);
    }
    if (published) await publish(published);
    if (spoken) await speak(spoken);
  } finally {
    for (const f of [raw, wav]) fs.existsSync(f) && fs.unlinkSync(f);
  }
}

// Long answers go to #zarya-archive if it exists, else the linked channel.
async function publish(markdown) {
  const guild = linkedTextChannel?.guild;
  const archive = guild?.channels.cache.find(
    (c) => c.name === 'zarya-archive' && c.type === ChannelType.GuildText,
  ) ?? linkedTextChannel;
  if (!archive) return;
  // Pull out IMAGE: lines; the text gets posted first, then the attachments.
  const images = [];
  const lines = markdown.split('\n').filter((line) => {
    const m = line.match(/^\s*IMAGE:\s*<?(https?:\/\/\S+?)>?\s*$/i);
    if (m) { images.push(m[1]); return false; }
    return true;
  });
  // Discord caps messages at 2000 chars; split on line boundaries.
  let buf = '';
  for (const line of lines) {
    if (buf.length + line.length + 1 > 1900) {
      await archive.send(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) await archive.send(buf);
  for (const url of images.slice(0, 4)) {
    const file = await fetchImage(url);
    if (file) await archive.send({ files: [file] }).catch(() => archive.send(url));
    else await archive.send(url); // let Discord try to embed it instead
  }
  if (archive.id !== linkedTextChannel?.id) {
    await linkedTextChannel?.send(`📚 Published to <#${archive.id}>`);
  }
}

// Download an image so it embeds as a real attachment (sidesteps hotlink blocks).
async function fetchImage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZaryaBot/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000 || buf.length > 8_000_000) return null; // tracking pixel / too big
    const ext = type.split('/')[1]?.split(';')[0] ?? 'png';
    const name = (url.split('/').pop() ?? 'image').split('?')[0].slice(-60) || `image.${ext}`;
    return { attachment: buf, name: name.includes('.') ? name : `${name}.${ext}` };
  } catch {
    return null;
  }
}

function askClaude(prompt) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = ['/c', 'claude', '-p', '--output-format', 'json', '--model', MODEL];
    if (state.sessionId) args.push('--resume', state.sessionId);
    console.log('asking claude...');
    // CLAUDE_TTS_OFF: the user-level Stop hook speaks every claude session aloud
    // on this machine; without this the bot's replies play on PC speakers AND
    // in Discord at the same time (two Zaryas).
    const child = spawn('cmd', args, { cwd: HERE, env: { ...process.env, CLAUDE_TTS_OFF: '1' } });
    let out = '', settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => console.error('claude stderr:', String(d).trim()));
    const timer = setTimeout(() => {
      console.error('claude TIMEOUT after 300s, killing tree');
      // child.kill() only kills cmd.exe and orphans the real process; nuke the tree.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      finish(null);
    }, 300_000); // research with web search can run a few minutes
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.session_id) { state.sessionId = res.session_id; saveState(); }
        console.log(`claude replied in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        finish((res.result ?? '').trim() || null);
      } catch {
        console.error('claude output unparseable:', out.slice(0, 300));
        finish(null);
      }
    });
    child.on('error', (e) => { clearTimeout(timer); console.error('claude spawn error:', e.message); finish(null); });
    child.stdin.end(prompt);
  });
}

async function speak(text) {
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) { console.error(`tts http ${res.status}`); return; }
  const stamp = Date.now();
  const wav = path.join(TMP, `say_${stamp}.wav`);
  const ogg = path.join(TMP, `say_${stamp}.ogg`);
  fs.writeFileSync(wav, Buffer.from(await res.arrayBuffer()));
  // Encode opus in ffmpeg (native) instead of the slow JS encoder.
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav,
    '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', ogg]);
  const resource = createAudioResource(fs.createReadStream(ogg), { inputType: StreamType.OggOpus });
  player.play(resource);
  await entersState(player, AudioPlayerStatus.Playing, 10_000).catch(() => {});
  await entersState(player, AudioPlayerStatus.Idle, 300_000).catch(() => {});
  for (const f of [wav, ogg]) fs.existsSync(f) && fs.unlinkSync(f);
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${bin} exit ${code}: ${err}`)));
  });
}

client.login(process.env.DISCORD_TOKEN);
