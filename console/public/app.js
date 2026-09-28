// © 2026 Mathew. All rights reserved.
// ZARYA//CONSOLE front-end — streams the real Claude engine into a cyberpunk log.
const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('reset');

let busy = false;

function setStatus(text, color) {
  statusEl.textContent = text;
  if (color) statusEl.style.color = color;
}

function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}
function scroll() { log.scrollTop = log.scrollHeight; }

function addMsg(who, label) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${who}`;
  const tag = document.createElement('div');
  tag.className = 'who';
  tag.textContent = label;
  const text = document.createElement('div');
  text.className = 'text';
  wrap.appendChild(tag);
  wrap.appendChild(text);
  log.appendChild(wrap);
  scroll();
  return { wrap, text };
}

// Render one stream-json event from the engine.
function handleEvent(evt, ctx) {
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) {
        ctx.text.textContent += block.text;
      } else if (block.type === 'tool_use') {
        const chip = document.createElement('div');
        chip.className = 'tool';
        chip.textContent = block.name + (block.input?.file_path ? ' · ' + block.input.file_path.split(/[\\/]/).pop() : '');
        ctx.wrap.appendChild(chip);
      }
    }
    if (atBottom()) scroll();
  } else if (evt.type === 'result') {
    if (!ctx.text.textContent && evt.result) ctx.text.textContent = evt.result;
  } else if (evt.type === 'stderr' || evt.type === 'fatal') {
    // Surface only real errors; the CLI logs noise to stderr too.
    if (/error|fatal|denied|cannot/i.test(evt.text || '')) {
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = evt.text.trim();
      ctx.wrap.appendChild(e);
    }
  }
}

async function send(message) {
  if (busy) return;
  busy = true;
  sendBtn.disabled = true;
  setStatus('LINK: ACTIVE', 'var(--green)');

  addMsg('user', 'GRILLO');
  const ctx = addMsg('zarya', 'ZARYA');
  ctx.text.innerHTML = '<span class="working">processing</span>';
  let started = false;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (!started && (evt.type === 'assistant' || evt.type === 'result')) {
          ctx.text.textContent = '';
          started = true;
        }
        handleEvent(evt, ctx);
      }
    }
    if (!ctx.text.textContent.trim()) ctx.text.textContent = '[no output]';
  } catch (err) {
    ctx.text.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = 'LINK SEVERED: ' + err;
    ctx.wrap.appendChild(e);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    setStatus('LINK: STANDBY', 'var(--cyan)');
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (!v || busy) return;
  input.value = '';
  input.style.height = 'auto';
  send(v);
});

// Enter sends, Shift+Enter newlines. Auto-grow.
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

resetBtn.addEventListener('click', async () => {
  if (busy) return;
  await fetch('/api/reset', { method: 'POST' });
  log.innerHTML = '<div class="boot"><p>> NEURAL LINK RESET</p><p>> fresh conversation, choom_</p></div>';
  setStatus('LINK: STANDBY', 'var(--cyan)');
  input.focus();
});
