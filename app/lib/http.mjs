import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { save, validate, hashPassword, verifyPassword, generateAdminName, publicUrl, ROOT, SHARED_PHOTON } from './config.mjs';
import { dotnetRuntime, postgresBin, serverCommand, downloadPostgres, portFree } from './deps.mjs';
import { listImages, imagePath, saveImage, getLoadingScreens, setLoadingScreens, getBoard, setBoard } from './content.mjs';
import { catalogStatus } from './catalog.mjs';
import { diagnostics, listBackups, createBackup, restoreBackup } from './ops.mjs';

const UI = path.join(ROOT, 'app', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SESSION_MS = 12 * 3600_000;
const PATCHER = path.join(ROOT, 'vendor', 'client', 'ReveriePatcher.dll');
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

// Panel actions map onto Mocha's own console commands so the logic stays in one place.
const ACTIONS = {
  ban: (id, v) => `ban-player ${id} ${posInt(v, 'Hours') || ''}`.trim(),
  unban: id => `unban-player ${id}`,
  'set-tokens': (id, v) => `set-balance ${id} ${posInt(v, 'Token amount', true)}`,
  'set-display': (id, v) => `set-display ${id} ${text(v, 'Display name')}`,
  'set-level': (id, v) => `change-level ${id} ${posInt(v, 'Level')}`,
  'reset-password': id => `reset-password ${id}`,
  'give-rrplus': id => `give-rrplus ${id}`,
};

function posInt(v, label, allowZero = false) {
  if (v === '' || v == null) return '';
  const n = Number(v);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new HttpError(400, `${label} must be a whole number.`);
  return n;
}
function text(v, label) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 40 || /[\r\n]/.test(s)) throw new HttpError(400, `${label} must be 1-40 characters.`);
  return s;
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createPanel(ctx) {
  const { sup } = ctx;
  const sessions = new Map();
  const desktopTokens = new Set();
  const failures = new Map();
  const download = { active: false, progress: 0, error: null };
  let auto = null;

  const fetchPostgres = () => {
    if (download.active) return download.promise;
    Object.assign(download, { active: true, progress: 0, error: null });
    download.promise = downloadPostgres(p => { download.progress = p; })
      .then(bin => { ctx.cfg.pgBin = bin; save(ctx.cfg); return bin; })
      .catch(e => { download.error = e.message; throw e; })
      .finally(() => { download.active = false; });
    download.promise.catch(() => {});
    return download.promise;
  };

  const freePort = async (start, taken) => {
    for (let p = start; p < start + 50; p++) if (!taken.includes(p) && await portFree(p)) return p;
    throw new Error(`No free port found near ${start}.`);
  };

  const failAt = (step, e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { step });

  // One click: everything the wizard asks, with defaults, then the first start.
  async function runAutoSetup() {
    const step = (id, label) => { const s = { id, label, state: 'running', detail: '' }; auto.steps.push(s); return s; };
    const cfg = ctx.cfg;
    let s = step('files', 'Game server files');
    const cmd = serverCommand();
    if (!cmd) throw failAt(s, new Error('The game server is not built. Download a Reverie release, or run "npm run build".'));
    if (cmd.needsRuntime && !dotnetRuntime()) throw failAt(s, new Error('Install the ASP.NET Core 8 runtime from dotnet.microsoft.com, then try again.'));
    Object.assign(s, { state: 'done', detail: 'Ready.' });

    s = step('database', 'Database');
    cfg.database.mode = 'managed';
    if (!postgresBin(cfg)) {
      if (process.platform !== 'win32') throw failAt(s, new Error('Install PostgreSQL 16 or newer with your package manager, then try again.'));
      s.detail = 'Downloading PostgreSQL (about 340 MB)...';
      const tick = setInterval(() => { s.detail = `Downloading PostgreSQL: ${Math.round(download.progress * 100)}%`; }, 500);
      try { await fetchPostgres(); } catch (e) { throw failAt(s, e); } finally { clearInterval(tick); }
    }
    Object.assign(s, { state: 'done', detail: 'PostgreSQL ready. Reverie keeps its own private database.' });

    s = step('ports', 'Ports');
    if (!sup.game.proc) {
      cfg.gamePort = await freePort(cfg.gamePort, [cfg.panelPort]);
      cfg.database.port = await freePort(cfg.database.port, [cfg.panelPort, cfg.gamePort]);
    }
    Object.assign(s, { state: 'done', detail: `Game ${cfg.gamePort}, database ${cfg.database.port}.` });

    s = step('settings', 'Settings');
    if (!cfg.photon.realtimeAppId) cfg.photon = { ...SHARED_PHOTON };
    const problems = validate(cfg);
    if (problems.length) throw failAt(s, new Error(problems.join(' ')));
    save(cfg);
    Object.assign(s, { state: 'done', detail: `"${cfg.serverName}", shared Photon app, administrator ${cfg.adminName}.` });

    s = step('start', 'First start');
    s.detail = 'Creating the database and starting the game server. This can take a minute.';
    try {
      if (!sup.game.proc) await sup.start();
      for (let i = 0; i < 240 && sup.game.state === 'starting'; i++) await new Promise(r => setTimeout(r, 500));
      if (sup.game.state !== 'running') throw new Error(sup.problem?.message || 'The server stopped while starting. Open Logs to see why.');
    } catch (e) { throw failAt(s, e); }
    // Only now, so a failed first start can be retried without losing the shown password.
    if (!cfg.adminPasswordHash) {
      auto.password = crypto.randomBytes(9).toString('base64url');
      cfg.adminPasswordHash = hashPassword(auto.password);
    }
    cfg.setupComplete = true;
    save(cfg);
    Object.assign(s, { state: 'done', detail: 'Your server is awake.' });
  }

  const ORDER = ['main', 'lan', 'vpn', 'other'];
  const kindOf = name => /^(wi-?fi|wlan\d*|ethernet|eth\d+|en\d+|wlp\w+|enp\w+)$/i.test(name) ? 'main'
    : /tailscale|zerotier|wireguard|hamachi|radmin/i.test(name) ? 'vpn'
    : /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|warp|loopback/i.test(name) ? 'other'
    : 'lan';
  const lanUrls = port => Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).map(n => ({ name, ...n })))
    .filter(n => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map(n => ({ url: `https://${n.address}:${port}`, kind: n.address.startsWith('192.168.56.') ? 'other' : kindOf(n.name) }))
    .sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind));


  ctx.desktopLink = () => {
    const t = crypto.randomBytes(24).toString('base64url');
    desktopTokens.add(t);
    setTimeout(() => desktopTokens.delete(t), 10 * 60_000);
    return `/auth/desktop?t=${t}`;
  };

  const newSession = res => {
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `reverie=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  };
  const authed = req => {
    const id = /(?:^|;\s*)reverie=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const exp = id && sessions.get(id);
    if (!exp || exp < Date.now()) { if (id) sessions.delete(id); return false; }
    return true;
  };

  const publicConfig = () => {
    const c = ctx.cfg;
    return {
      setupComplete: c.setupComplete, adminName: c.adminName, hasPassword: !!c.adminPasswordHash,
      serverName: c.serverName, gamePort: c.gamePort, panelPort: c.panelPort, panelLan: c.panelLan,
      publicUrl: c.publicUrl, autoStart: c.autoStart, pgBin: c.pgBin, motd: c.motd,
      database: { ...c.database, password: c.database.mode === 'external' ? (c.database.password ? '********' : '') : undefined },
      photon: c.photon,
      photonAuth: { url: `${publicUrl(c)}/photon/authenticate`, secret: c.secrets.photonAuth },
    };
  };

  function applySettings(body) {
    const next = structuredClone(ctx.cfg);
    const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    if ('adminName' in body) next.adminName = str(body.adminName, 40);
    if ('serverName' in body) next.serverName = str(body.serverName, 60);
    for (const k of ['gamePort', 'panelPort']) if (k in body) next[k] = Number(body[k]);
    if ('panelLan' in body) next.panelLan = !!body.panelLan;
    if ('autoStart' in body) next.autoStart = !!body.autoStart;
    if ('publicUrl' in body) next.publicUrl = str(body.publicUrl).replace(/\/+$/, '');
    if ('pgBin' in body) next.pgBin = str(body.pgBin, 500);
    if ('motd' in body) next.motd = str(body.motd, 200).replace(/[\r\n]+/g, ' ');
    if (body.photon) for (const k of ['realtimeAppId', 'voiceAppId', 'region']) if (k in body.photon) next.photon[k] = str(body.photon[k], 64);
    if (body.database) {
      const d = body.database;
      if (d.mode === 'managed' || d.mode === 'external') next.database.mode = d.mode;
      for (const k of ['host', 'name', 'user']) if (k in d) next.database[k] = str(d[k], 120);
      if ('port' in d) next.database.port = Number(d.port);
      if (d.password && d.password !== '********' && next.database.mode === 'external') next.database.password = String(d.password);
    }
    if (body.password != null) {
      if (String(body.password).length < 8) throw new HttpError(400, 'The panel password must be at least 8 characters.');
      next.adminPasswordHash = hashPassword(String(body.password));
    }
    const problems = validate(next);
    if (problems.length) throw new HttpError(400, problems.join(' '));
    const restart = ['gamePort', 'publicUrl', 'serverName', 'motd'].some(k => next[k] !== ctx.cfg[k]) ||
      JSON.stringify([next.database, next.photon]) !== JSON.stringify([ctx.cfg.database, ctx.cfg.photon]);
    const panelMoved = next.panelPort !== ctx.cfg.panelPort || next.panelLan !== ctx.cfg.panelLan;
    ctx.cfg = next;
    save(next);
    return { restartServer: restart && !!sup.game.proc, restartApp: panelMoved };
  }

  const routes = {
    'GET /api/hello': () => ({ setupComplete: ctx.cfg.setupComplete, serverName: ctx.cfg.serverName }),
    'POST /api/login': (req, res, body) => {
      const c = ctx.cfg;
      const ip = req.socket.remoteAddress;
      const fails = (failures.get(ip) ?? []).filter(t => t > Date.now() - 15 * 60_000);
      if (fails.length >= 10) throw new HttpError(429, 'Too many failed sign-ins. Wait 15 minutes and try again.');
      const ok = c.setupComplete && String(body.username ?? '').trim() === c.adminName && verifyPassword(body.password ?? '', c.adminPasswordHash);
      if (!ok) { failures.set(ip, [...fails, Date.now()]); throw new HttpError(401, 'That name and password do not match.'); }
      failures.delete(ip);
      newSession(res);
      return { ok: true };
    },
    'POST /api/logout': (req, res) => {
      const id = /(?:^|;\s*)reverie=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
      sessions.delete(id);
      res.setHeader('Set-Cookie', 'reverie=; Path=/; Max-Age=0');
      return { ok: true };
    },
  };

  const private_ = {
    'GET /api/config': () => publicConfig(),
    'POST /api/config': (req, res, body) => ({ ...applySettings(body), config: publicConfig() }),
    'POST /api/setup/regenerate-name': () => { ctx.cfg.adminName = generateAdminName(); save(ctx.cfg); return publicConfig(); },
    'POST /api/setup/complete': () => {
      const problems = validate(ctx.cfg);
      if (!ctx.cfg.adminPasswordHash) problems.push('Set a panel password first.');
      if (problems.length) throw new HttpError(400, problems.join(' '));
      ctx.cfg.setupComplete = true;
      save(ctx.cfg);
      return { ok: true };
    },
    'GET /api/deps': () => ({
      server: serverCommand()?.kind ?? null,
      dotnet: dotnetRuntime(),
      needsDotnet: !!serverCommand()?.needsRuntime,
      postgres: postgresBin(ctx.cfg),
      platform: process.platform,
      download,
      catalogs: catalogStatus(),
    }),
    'POST /api/deps/postgres': () => { fetchPostgres(); return download; },
    'POST /api/setup/auto': () => {
      if (auto?.running) return auto;
      auto = { running: true, done: false, error: null, steps: [], password: null };
      runAutoSetup()
        .then(() => { auto.done = true; })
        .catch(e => { auto.error = e.message; if (e.step) Object.assign(e.step, { state: 'failed', detail: e.message }); })
        .finally(() => { auto.running = false; });
      return auto;
    },
    'GET /api/setup/auto': () => auto ?? { running: false, done: false, error: null, steps: [] },
    'GET /api/content': () => ({ loading: getLoadingScreens(), board: getBoard(), motd: ctx.cfg.motd, serverName: ctx.cfg.serverName, images: listImages() }),
    'POST /api/content/loading': (req, res, body) => { try { return { loading: setLoadingScreens(body.screens) }; } catch (e) { throw new HttpError(400, e.message); } },
    'POST /api/content/board': (req, res, body) => { try { return { board: setBoard(body) }; } catch (e) { throw new HttpError(400, e.message); } },
    'POST /api/images': (req, res, body) => { try { return { name: saveImage(body.name, body.data), images: listImages() }; } catch (e) { throw new HttpError(400, e.message); } },
    'GET /api/invite': () => ({
      lan: lanUrls(ctx.cfg.gamePort),
      local: `https://127.0.0.1:${ctx.cfg.gamePort}`,
      publicUrl: ctx.cfg.publicUrl,
      patcher: fs.existsSync(PATCHER),
      gamePort: ctx.cfg.gamePort,
    }),
    'GET /api/diagnostics': () => diagnostics(sup),
    'GET /api/overview': async () => {
      let stats = null, statsError = null;
      try { stats = await sup.api('status'); } catch (e) { statsError = e.message; }
      return { ...sup.snapshot(), stats, statsError, serverName: ctx.cfg.serverName, gamePort: ctx.cfg.gamePort, panelPort: ctx.cfg.panelPort };
    },
    'POST /api/server/start': async () => { await sup.start(); return sup.snapshot(); },
    'POST /api/server/stop': async () => { await sup.stop(); return sup.snapshot(); },
    'POST /api/server/restart': async () => { await sup.stop(); await sup.start(); return sup.snapshot(); },
    'GET /api/logs': (req, res, body, url) => {
      const since = Number(url.searchParams.get('since')) || 0;
      return sup.lines.filter(l => l.id > since).slice(-1000);
    },
    'GET /api/players': async (req, res, body, url) => {
      if (sup.game.state !== 'running') throw new HttpError(409, 'Start the server to see players.');
      const q = encodeURIComponent(url.searchParams.get('q') ?? '');
      return sup.api(`players?q=${q}&limit=200`);
    },
    'POST /api/players/action': async (req, res, body) => {
      const make = ACTIONS[body.action];
      if (!make) throw new HttpError(400, 'Unknown action.');
      const id = posInt(body.id, 'Player id');
      if (!id) throw new HttpError(400, 'Player id is required.');
      const output = await sup.command(make(id, body.value));
      return { output };
    },
    'GET /api/backups': () => listBackups(),
    'POST /api/backups': () => ({ name: createBackup(sup) }),
    'POST /api/backups/restore': async (req, res, body) => { await restoreBackup(sup, String(body.name ?? '')); return { ok: true }; },
    'GET /api/compat': () => JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'compat', 'clients.json'), 'utf8')),
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (req.method === 'GET' && url.pathname === '/auth/desktop') {
        const t = url.searchParams.get('t');
        if (!t || !desktopTokens.delete(t)) throw new HttpError(403, 'This link has expired. Reopen Reverie.');
        newSession(res);
        res.writeHead(302, { Location: '/' }).end();
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/api/images/file' || url.pathname === '/api/client/patcher')) {
        if (!authed(req)) throw new HttpError(401, 'Please sign in.');
        const patcher = url.pathname === '/api/client/patcher';
        const file = patcher ? (fs.existsSync(PATCHER) ? PATCHER : null) : imagePath(url.searchParams.get('name'));
        if (!file) throw new HttpError(404, 'Not found.');
        res.writeHead(200, patcher
          ? { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="ReveriePatcher.dll"' }
          : { 'Content-Type': IMAGE_TYPES[path.extname(file).toLowerCase()], 'Cache-Control': 'private, max-age=300' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      const handler = routes[key] ?? private_[key];
      if (!handler) return serveStatic(url.pathname, res);
      if (req.method === 'POST' && req.headers['x-reverie'] !== '1') throw new HttpError(403, 'Missing request header.');
      if (!routes[key] && !authed(req)) throw new HttpError(401, 'Please sign in.');
      const body = req.method === 'POST' ? await readJson(req, key === 'POST /api/images' ? 9 * 1024 * 1024 : 64 * 1024) : {};
      const result = await handler(req, res, body, url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) sup.log('reverie', `Panel error on ${key}: ${e.message}`, 'error');
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
  });
}

function readJson(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new HttpError(400, 'Invalid JSON.')); } });
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(UI, rel);
  if (!file.startsWith(UI + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}
