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
  { id: 'git-forge',     name: 'Git Forge',          cat: 'Web Apps', dir: 'webdev/git-forge',              cmd: 'node',   args: ['server.js'],          url: 'http://localhost:3000',  type: 'web',  desc: 'Local GitHub-style git manager' },
  { id: 'smart-home',    name: 'Smart Home Hub',     cat: 'Web Apps', dir: 'webdev/smart-home-hub/Speaker', cmd: 'python', args: ['server.py'],          url: 'http://localhost:5000',  type: 'web',  desc: 'Smart home dashboard · Spotify · weather' },

  // Python
  { id: 'bullet-hell',   name: 'Bullet Hell',        cat: 'Python',   dir: 'python/bullet-hell',            cmd: 'python', args: ['Bullet Hell.py'],     type: 'gui', desc: 'Arcade bullet hell shooter' },
{ id: 'llm-router',    name: 'LLM Router',         cat: 'Python',   dir: 'python/llm-router',             cmd: 'python', args: ['smartformer.py'],     type: 'cli', desc: 'Adaptive LLM weight routing framework' },
  { id: 'manim',         name: 'Manim Animations',   cat: 'Python',   dir: 'python/manim-animations',       cmd: 'python', args: ['untitled 1.py'],      type: 'cli', desc: 'Mathematical animation renderer' },
  { id: 'celeste',       name: 'Celeste',            cat: 'Python',   dir: 'python/python-games',           cmd: 'python', args: ['Celeste.py'],         type: 'gui', desc: 'Celeste-inspired platformer' },
  { id: 'human-bench',   name: 'Human Benchmark',    cat: 'Python',   dir: 'python/python-games',           cmd: 'python', args: ['Human Benchmark.py'], type: 'cli', desc: 'Reaction time & memory benchmarks' },
  { id: 'ascii-record',  name: 'ASCII Record',       cat: 'Python',   dir: 'python/python-games',           cmd: 'python', args: ['Ascii Record.py'],    type: 'cli', desc: 'ASCII animation recorder' },
  { id: 'rps-royale',    name: 'RPS Battle Royale',  cat: 'Python',   dir: 'python/rps-battle-royale',      cmd: 'python', args: ['RPSBR.py'],           type: 'gui', desc: 'Rock Paper Scissors physics simulation' },
  { id: 'terminal-idle', name: 'Terminal Idle',       cat: 'Python',   dir: 'python/terminal-idle',          cmd: 'python', args: ['terminal_idle.py'],   type: 'cli', desc: 'Terminal-based idle/incremental game' },
  { id: 'power-of-50',   name: 'Power of 50',        cat: 'Python',   dir: 'python/power-of-50',            cmd: 'python', args: ['-m', 'games'],        type: 'gui', desc: 'Multi-game arcade — always reach 50' },

  // C / CUDA
  { id: 'cuda-compute',  name: 'CUDA Compute',       cat: 'C / CUDA', dir: 'c/cuda-compute',                cmd: IS_WIN ? 'merged.exe' : './merged', args: [], type: 'cli', desc: 'GPU parallel computing with CUDA/OpenCL' },

  // C#
  { id: 'igtap-editor',  name: 'IGTAP Map Editor',   cat: 'C#',       dir: 'csharp/igtap-map-editor',       type: 'info', desc: 'BepInEx Unity plugin — copy to IGTAP game folder to use' },
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
