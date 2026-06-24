#!/usr/bin/env node
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DIR       = __dirname;
const IS_WIN    = process.platform === 'win32';
const CF_DOMAIN = 'codecade.co.za';
const PORT      = 4000;

const ts  = () => new Date().toTimeString().slice(0, 8);
const log = m => console.log(`[${ts()}] ${m}`);
const ok  = m => console.log(`  ok   ${m}`);
const inf = m => console.log(`  ..   ${m}`);
const die = m => { console.error(`\n  ERR  ${m}\n`); process.exit(1); };

// ── Find binary: bundled bin/ first, then system PATH ─────────────────────────
function findBin(name) {
  const platform = IS_WIN ? 'win' : 'linux';
  const ext      = IS_WIN ? '.exe' : '';
  // Check portal/bin first, then temutalk's bin
  for (const base of [DIR, path.join(DIR, '..', 'webdev', 'temutalk')]) {
    for (const sub of [platform, '']) {
      const bundled = path.join(base, 'bin', sub, name + ext);
      if (fs.existsSync(bundled)) return bundled;
    }
  }
  try {
    const cmd   = IS_WIN ? 'where' : 'which';
    const found = execFileSync(cmd, [name], { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (found) return found;
  } catch {}
  return null;
}

// ── Write cloudflared config pointing at this portal ─────────────────────────
function writeCfConfig() {
  // Look for credentials: portal/.cloudflared/ first, then temutalk's
  const cfDirs = [
    path.join(DIR, '.cloudflared'),
    path.join(DIR, '..', 'webdev', 'temutalk', '.cloudflared'),
  ];
  let cfDir = null;
  let jsons = [];
  for (const d of cfDirs) {
    if (!fs.existsSync(d)) continue;
    const found = fs.readdirSync(d).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f));
    if (found.length) { cfDir = d; jsons = found; break; }
  }
  if (!cfDir) return null;

  const tunnelId   = jsons[0].replace('.json', '');
  const credsFile  = path.join(cfDir, jsons[0]);
  const certFile   = path.join(cfDir, 'cert.pem');
  const configFile = path.join(DIR, '.cloudflared', 'config.yml');
  fs.mkdirSync(path.join(DIR, '.cloudflared'), { recursive: true });
  const ingress = [
    { host: CF_DOMAIN,              service: `https://localhost:${PORT}`, tls: true  },
    { host: `cast.${CF_DOMAIN}`,   service: 'https://localhost:3001',     tls: true  },
    { host: `forge.${CF_DOMAIN}`,  service: 'http://localhost:3000',      tls: false },
    { host: `home.${CF_DOMAIN}`,   service: 'http://localhost:5000',      tls: false },
  ];
  const ingressYml = ingress.map(i =>
    `  - hostname: ${i.host}\n    service: ${i.service}` +
    (i.tls ? `\n    originRequest:\n      noTLSVerify: true` : '')
  ).join('\n') + '\n  - service: http_status:404';

  fs.writeFileSync(configFile, [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credsFile}`,
    `ingress:`,
    ingressYml,
    '',
  ].join('\n'));
  return { tunnelId, configFile, certFile: fs.existsSync(certFile) ? certFile : null };
}

// ── Kill any process on a port ────────────────────────────────────────────────
function killPort(port) {
  try {
    if (IS_WIN) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && pid !== '0')
            try { execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }); } catch {}
        }
      }
    } else {
      try { execFileSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' }); } catch {}
    }
  } catch {}
}

function executableBin(src) {
  try {
    const dest = path.join(os.tmpdir(), 'portal-' + path.basename(src));
    fs.copyFileSync(src, dest);
    if (!IS_WIN) fs.chmodSync(dest, 0o755);
    else {
      try { execFileSync('powershell', ['-Command', `Unblock-File -LiteralPath '${dest}'`], { stdio: 'ignore' }); } catch {}
    }
    return dest;
  } catch { return src; }
}

function startServer() {
  killPort(PORT);
  return spawn(process.execPath, [path.join(DIR, 'server.js')], { cwd: DIR, stdio: 'inherit' });
}

function startTunnel(cfg) {
  const cfBin = findBin('cloudflared');
  if (!cfBin || !cfg) return null;
  const args = [];
  if (cfg.certFile) args.push('--origincert', cfg.certFile);
  args.push('--config', cfg.configFile, 'tunnel', 'run');
  const proc = spawn(executableBin(cfBin), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.on('error', err => log(`tunnel error: ${err.message}`));
  return proc;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log('\n  CodeCade Portal');
console.log(`  ${os.platform()} — ${DIR}\n`);

if (!fs.existsSync(path.join(DIR, 'node_modules')))
  die('node_modules missing — run: npm install');

const cfCfg = writeCfConfig();
inf('starting server...');
let server = startServer();
let tunnel = null;

setTimeout(() => {
  if (server.exitCode !== null) die('server.js exited — check output above');
  log(`server running  PID ${server.pid}`);

  if (!cfCfg) { log('no cloudflare credentials — local only'); return; }
  inf('starting tunnel...');
  tunnel = startTunnel(cfCfg);
  setTimeout(() => {
    if (!tunnel || tunnel.exitCode !== null) {
      log('tunnel failed — local only');
      tunnel = null;
    } else {
      ok(`tunnel live → https://${CF_DOMAIN}`);
    }
  }, 3000);
}, 2000);

// ── Monitor & restart ─────────────────────────────────────────────────────────
console.log('  Running — Ctrl+C to quit.\n');

setInterval(() => {
  if (server.exitCode !== null) {
    log('server crashed — restarting');
    server = startServer();
    log(`server restarted  PID ${server.pid}`);
  }
  if (cfCfg && tunnel && tunnel.exitCode !== null) {
    log('tunnel died — restarting');
    tunnel = startTunnel(cfCfg);
  }
}, 5000);

function shutdown() {
  console.log('\n  Shutting down...');
  try { server?.kill(); } catch {}
  try { tunnel?.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
