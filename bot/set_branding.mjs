// © 2026 Mathew. All rights reserved.
// Sets Zarya's Discord avatar, banner, and description from branding/ files.
// Avatar + banner: PATCH /users/@me. Description ("About Me"): PATCH /applications/@me.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'branding');
const TOKEN = process.env.DISCORD_TOKEN;
const API = 'https://discord.com/api/v10';

// Zarya's profile bio. Edit freely, then re-run.
const DESCRIPTION =
  'Late-night netrunner riding shotgun in GRILLONIA PRIME. I hear you in voice, ' +
  'remember the whole crew, run the music, and dig up intel on command. ' +
  'Say "Zarya" and I am already listening. Built on Grillo\'s own rig — local voice, local ears.';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

function dataUri(stem) {
  for (const ext of Object.keys(MIME)) {
    const p = path.join(DIR, stem + ext);
    if (fs.existsSync(p)) {
      const b64 = fs.readFileSync(p).toString('base64');
      return { uri: `data:${MIME[ext]};base64,${b64}`, file: stem + ext };
    }
  }
  return null;
}

async function patch(endpoint, body, label) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'PATCH',
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) { console.log(`OK: ${label}`); return true; }
  console.error(`FAIL ${label}: ${res.status} ${await res.text()}`);
  return false;
}

// Flags let us update one thing without re-pushing the rate-limited avatar.
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const doAvatar = !only || only === 'avatar';
const doBanner = !only || only === 'banner';
const doDesc = !only || only === 'desc';

const avatar = doAvatar ? dataUri('avatar') : null;
const banner = doBanner ? dataUri('banner') : null;

const userBody = {};
if (avatar) { userBody.avatar = avatar.uri; console.log(`found avatar: ${avatar.file}`); }
if (banner) { userBody.banner = banner.uri; console.log(`found banner: ${banner.file}`); }

if (Object.keys(userBody).length) await patch('/users/@me', userBody, 'avatar/banner');
else console.log('no image to update for this run');

if (doDesc) await patch('/applications/@me', { description: DESCRIPTION }, 'description');
console.log('done. (avatar/banner may take a minute to show in Discord)');
