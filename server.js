'use strict';
const https   = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT        = 4000;
const SCRIPTS_DIR = path.join(__dirname, '..');
const IS_WIN      = process.platform === 'win32';

// ── Self-signed TLS ───────────────────────────────────────────────────────────
const CERT_F = path.join(__dirname, '.cert-cert.pem');
const KEY_F  = path.join(__dirname, '.cert-key.pem');
if (!fs.existsSync(CERT_F) || !fs.existsSync(KEY_F)) {
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 3650, keySize: 2048 });
  fs.writeFileSync(CERT_F, pems.cert);
  fs.writeFileSync(KEY_F,  pems.private);
}
const tlsOpts = { cert: fs.readFileSync(CERT_F), key: fs.readFileSync(KEY_F) };

// ── Project definitions ───────────────────────────────────────────────────────
const PROJECTS = [
  // Web Apps
  { id: 'temutalk',      name: 'TemuTalk',          cat: 'Web Apps', dir: 'webdev/temutalk',               cmd: 'node',   args: ['server.js'],          url: '/cast',                  type: 'web',  desc: 'Smart display hub · Spotify · audio casting' },
  { id: 'git-forge',     name: 'Git Forge',          cat: 'Web Apps', dir: 'webdev/git-forge',              cmd: 'node',   args: ['server.js'],          url: '/forge',                 type: 'web',  desc: 'Local GitHub-style git manager' },
  { id: 'smart-home',    name: 'Smart Home Hub',     cat: 'Web Apps', dir: 'webdev/smart-home-hub/Speaker', cmd: 'python', args: ['server.py'],          url: '/home',                  type: 'web',  desc: 'Smart home dashboard · Spotify · weather' },

];

// ── Process registry ──────────────────────────────────────────────────────────
// id → { proc, lines: string[], exitCode: number|null }
const procs = new Map();

// ── WebSocket broadcast ───────────────────────────────────────────────────────
// id → Set<WebSocket>
const subs = new Map();

function broadcast(id, msg) {
  const clients = subs.get(id);
  if (!clients) return;
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(str); } catch {}
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Proxy /cast/* → TemuTalk on port 3001
const temuProxy = createProxyMiddleware({
  target: 'https://localhost:3001',
  changeOrigin: true,
  secure: false,
  pathRewrite: { '^/cast': '' },
  ws: true,
});
app.use('/cast', temuProxy);

const forgeProxy = createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true,
  pathRewrite: { '^/forge': '' },
  ws: true,
});
app.use('/forge', forgeProxy);

const homeProxy = createProxyMiddleware({
  target: 'http://localhost:5000',
  changeOrigin: true,
  pathRewrite: { '^/home': '' },
  ws: true,
});
app.use('/home', homeProxy);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/projects', (_req, res) => {
  res.json(PROJECTS.map(p => ({ ...p, running: procs.has(p.id) })));
});

app.get('/api/output/:id', (req, res) => {
  const state = procs.get(req.params.id);
  res.json({ lines: state ? state.lines : [] });
});

app.post('/api/launch/:id', (req, res) => {
  const p = PROJECTS.find(x => x.id === req.params.id);
  if (!p)              return res.status(404).json({ error: 'unknown project' });
  if (p.type === 'info') return res.json({ ok: true, info: true });
  if (procs.has(p.id))   return res.json({ ok: true, already: true });
  const cwd = path.join(SCRIPTS_DIR, p.dir);
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: `dir not found: ${cwd}` });
  launchProject(p);
  res.json({ ok: true });
});

app.post('/api/stop/:id', (req, res) => {
  const state = procs.get(req.params.id);
  if (!state) return res.json({ ok: true });
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(state.proc.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
    } else {
      state.proc.kill('SIGTERM');
    }
  } catch {}
  procs.delete(req.params.id);
  broadcast(req.params.id, { type: 'exit', code: null });
  res.json({ ok: true });
});

// ── HTTPS server + WebSocket ──────────────────────────────────────────────────
const server = https.createServer(tlsOpts, app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let subId = null;

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe') {
        if (subId && subs.has(subId)) subs.get(subId).delete(ws);
        subId = msg.id;
        if (!subs.has(subId)) subs.set(subId, new Set());
        subs.get(subId).add(ws);
        // Replay buffered output
        const state = procs.get(subId);
        if (state && state.lines.length) {
          ws.send(JSON.stringify({ type: 'out', text: state.lines.join('\n') + '\n' }));
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    if (subId && subs.has(subId)) subs.get(subId).delete(ws);
  });
});

function launchProject(p) {
  if (p.type === 'info' || p.type === 'gui') return;
  if (procs.has(p.id)) return;
  const cwd = path.join(SCRIPTS_DIR, p.dir);
  if (!fs.existsSync(cwd)) return;
  const proc = spawn(p.cmd, p.args, {
    cwd,
    shell: IS_WIN,
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_COLOR: '0', NO_TUNNEL: '1' },
  });
  const state = { proc, lines: [], exitCode: null };
  procs.set(p.id, state);
  function handleStream(stream) {
    stream.on('data', chunk => {
      const text = chunk.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      for (const line of text.split('\n')) {
        if (line === '' && text.endsWith('\n')) continue;
        state.lines.push(line);
        if (state.lines.length > 1000) state.lines.shift();
      }
      broadcast(p.id, { type: 'out', text });
    });
  }
  if (proc.stdout) handleStream(proc.stdout);
  if (proc.stderr) handleStream(proc.stderr);
  proc.on('error', err => {
    const msg = `[error] ${err.message}\n`;
    state.lines.push(msg);
    broadcast(p.id, { type: 'out', text: msg });
  });
  proc.on('close', code => {
    state.exitCode = code;
    broadcast(p.id, { type: 'exit', code });
    procs.delete(p.id);
    // auto-restart web services
    if (p.type === 'web') setTimeout(() => launchProject(p), 3000);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Portal: https://localhost:${PORT}\n`);
  // Auto-launch all web and cli projects
  setTimeout(() => PROJECTS.forEach(launchProject), 1000);
});
