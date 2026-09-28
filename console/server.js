// © 2026 Mathew. All rights reserved.
// ZARYA//CONSOLE — local server bridging a custom web UI to the real Claude Code engine.
// Zero dependencies. Spawns the headless `claude` CLI in stream-json mode so Zarya
// keeps every tool (file edits, terminal, the works) while wearing a custom face.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.ZARYA_CONSOLE_PORT || 8788;
// Folder the engine works in (defaults to the directory the console was started from).
const WORKDIR = process.env.ZARYA_WORKDIR || process.cwd();
// Claude Code CLI binary: CLAUDE_PATH, else the npm global install on Windows, else `claude` on PATH.
const CLAUDE_EXE = process.env.CLAUDE_PATH || (() => {
  const winExe = path.join(process.env.APPDATA || '', 'npm', 'node_modules',
    '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return process.platform === 'win32' && fs.existsSync(winExe) ? winExe : 'claude';
})();
const PUBLIC = path.join(__dirname, 'public');

// One continuous conversation. We capture the session_id from the engine's first
// reply, then --resume it every turn after, so context never resets.
let sessionId = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Stream a single turn: spawn claude headless, forward each NDJSON event to the browser.
function handleChat(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let message = '';
    try {
      message = JSON.parse(body).message || '';
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    if (!message.trim()) {
      res.writeHead(400).end('empty');
      return;
    }

    const args = [
      '-p', message,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (sessionId) args.push('--resume', sessionId);

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // stdin: 'ignore' is critical — with an open stdin pipe, `claude -p` blocks
    // waiting to read it instead of using the prompt argument.
    const child = spawn(CLAUDE_EXE, args, {
      cwd: WORKDIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // Capture/refresh the session id so the next turn resumes this conversation.
        try {
          const evt = JSON.parse(line);
          if (evt.session_id) sessionId = evt.session_id;
        } catch {
          /* forward raw anyway */
        }
        res.write(line + '\n');
      }
    });

    child.stderr.on('data', (d) => {
      res.write(JSON.stringify({ type: 'stderr', text: d.toString() }) + '\n');
    });

    child.on('close', (code) => {
      if (buf.trim()) res.write(buf.trim() + '\n');
      res.write(JSON.stringify({ type: 'exit', code }) + '\n');
      res.end();
    });

    child.on('error', (err) => {
      res.write(JSON.stringify({ type: 'fatal', text: String(err) }) + '\n');
      res.end();
    });

    // Kill the engine only if the client actually disconnects mid-stream — NOT
    // when the request body finishes (that fires immediately and would abort us).
    res.on('close', () => {
      if (!res.writableFinished) child.kill();
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && req.url === '/api/reset') {
    sessionId = null;
    res.writeHead(200).end('{"ok":true}');
    return;
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  ZARYA//CONSOLE online`);
  console.log(`  Local : http://localhost:${PORT}`);
  console.log(`  Workdir: ${WORKDIR}\n`);
});
