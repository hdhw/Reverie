import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import https from 'node:https';
import { DATA, TLS_CERT, TLS_PEM, publicUrl } from './config.mjs';
import { SERVER_DIR, serverCommand, postgresBin, pgTool, portOpen, portFree, dotnetRuntime } from './deps.mjs';
import { importCatalog, renderGameConfig } from './catalog.mjs';

const PGDATA = path.join(DATA, 'pgdata');
const SERVER_PID = path.join(DATA, 'server.pid');
const MAX_LINES = 3000;
const DOTNET_MISSING = 'The .NET 8 runtime is missing. Install "ASP.NET Core Runtime 8" from dotnet.microsoft.com, then try again.';

// Known failure text -> what a first-time host should do about it.
const EXPLAIN = [
  [/address already in use|Failed to bind|EADDRINUSE|Only one usage of each socket address/i,
    'Another program is already using one of Reverie\'s ports. Close it, or pick a different port in Settings.'],
  [/password authentication failed/i,
    'The database rejected the password. If you use your own PostgreSQL server, check the user and password in Settings.'],
  [/Connection refused|could not connect to server|No connection could be made/i,
    'Reverie could not reach the database. If it is your own PostgreSQL server, make sure it is running.'],
  [/database ".*" does not exist/i, 'The database does not exist yet. Create it on your PostgreSQL server, or switch to the managed database.'],
  [/Missing required secret/i, 'A required secret is missing from the configuration. Re-run setup from Settings.'],
  [/You must install or update \.NET|framework 'Microsoft\.AspNetCore\.App'.*was not found/is, DOTNET_MISSING],
  [/lock file "postmaster\.pid" already exists/i, 'A database from a previous run is still open. Restart your computer if this keeps happening.'],
  [/TypeInitializationException/i, 'The server crashed while loading its data. The lines just above this one show the real cause.'],
];

export const explain = text => EXPLAIN.find(([re]) => re.test(text))?.[1] ?? null;

export class Supervisor extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.lines = [];
    this.seq = 0;
    this.db = { state: 'stopped', proc: null };
    this.game = { state: 'stopped', proc: null, startedAt: null };
    this.problem = null;
  }

  log(src, text, level = 'info') {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.replace(/^> /, '');
      if (!line.trim() || / \/reverie\/\w+/.test(line)) continue;
      const entry = { id: ++this.seq, t: Date.now(), src, level: /\[(ERROR|FATAL)\]|FATAL:|Unhandled exception/.test(line) ? 'error' : level, text: line };
      this.lines.push(entry);
      if (this.lines.length > MAX_LINES) this.lines.shift();
      this.emit('line', entry);
      const hint = entry.level === 'error' && explain(line);
      if (hint) this.setProblem(hint, line);
    }
  }

  setProblem(message, detail) {
    this.problem = { message, detail, t: Date.now() };
    this.emit('problem', this.problem);
  }

  dbEnv(cfg) {
    const d = cfg.database;
    return { PGHOST: d.host, PGPORT: String(d.port), PGUSER: d.user, PGPASSWORD: d.password, PGDATABASE: d.name };
  }

  async startDb() {
    const cfg = this.getConfig();
    const d = cfg.database;
    if (d.mode === 'external') {
      if (!(await portOpen(d.port, d.host, 3000))) throw new Error(`Nothing is answering at ${d.host}:${d.port}. Make sure your PostgreSQL server is running.`);
      this.db.state = 'external';
      return;
    }
    if (this.db.proc) return;
    const bin = postgresBin(cfg);
    if (!bin) throw new Error('PostgreSQL is not installed. Open Setup > Database to download it.');
    if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) {
      this.log('reverie', 'Creating a new private database (first run only)...');
      const pw = path.join(DATA, '.pwfile');
      fs.writeFileSync(pw, d.password, { mode: 0o600 });
      const r = spawnSync(pgTool(bin, 'initdb'), ['-D', PGDATA, '-U', d.user, `--pwfile=${pw}`, '-A', 'scram-sha-256', '-E', 'UTF8'], { encoding: 'utf8', windowsHide: true });
      fs.rmSync(pw, { force: true });
      if (r.status !== 0) {
        fs.rmSync(PGDATA, { recursive: true, force: true });
        throw new Error(`Could not create the database: ${(r.stderr || r.error?.message || '').trim()}`);
      }
    }
    // A database left running by a crashed or killed Reverie: shut it down cleanly first.
    if (fs.existsSync(path.join(PGDATA, 'postmaster.pid'))) {
      spawnSync(pgTool(bin, 'pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast', '-w'], { windowsHide: true, stdio: 'ignore', timeout: 20000 });
    }
    if (!(await portFree(d.port, '127.0.0.1'))) throw new Error(`Port ${d.port} (database) is already in use by another program. Change the database port in Settings.`);
    this.db.state = 'starting';
    const proc = spawn(pgTool(bin, 'postgres'), ['-D', PGDATA, '-p', String(d.port), '-c', 'listen_addresses=127.0.0.1'], { windowsHide: true });
    this.db.proc = proc;
    proc.stdout.on('data', b => this.log('database', b));
    proc.stderr.on('data', b => this.log('database', b));
    proc.on('exit', code => {
      this.db.proc = null;
      this.db.state = this.db.state === 'stopping' ? 'stopped' : 'crashed';
      this.log('reverie', `Database stopped (code ${code}).`, code ? 'error' : 'info');
    });
    for (let i = 0; i < 60 && this.db.proc; i++) {
      if (await portOpen(d.port)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!this.db.proc) throw new Error('The database stopped while starting. See the log for details.');
    let created;
    for (let i = 0; i < 60; i++) {
      created = spawnSync(pgTool(bin, 'createdb'), [d.name], { env: { ...process.env, ...this.dbEnv(cfg) }, encoding: 'utf8', windowsHide: true });
      // After an unclean shutdown the port opens before crash recovery finishes.
      if (!/starting up|shutting down/.test(created.stderr)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (created.status !== 0 && !/already exists/.test(created.stderr)) {
      await this.stopDb();
      throw new Error(`Could not create the "${d.name}" database: ${created.stderr.trim()}`);
    }
    this.db.state = 'running';
  }

  async start() {
    if (this.game.proc) return;
    this.problem = null;
    const cfg = this.getConfig();
    const cmd = serverCommand();
    if (!cmd) throw new Error('The game server has not been built yet. Run "npm run build" in the Reverie folder.');
    if (cmd.needsRuntime && !dotnetRuntime()) throw new Error(DOTNET_MISSING);
    killStale();
    if (!(await portFree(cfg.gamePort))) throw new Error(`Port ${cfg.gamePort} (game server) is already in use by another program. Change the game port in Settings.`);

    for (const w of importCatalog()) this.log('reverie', `Installed ${w.file} (${w.items} entries, ${w.source}).`);
    renderGameConfig(cfg);

    try { await this.startDb(); } catch (e) { this.setProblem(e.message); throw e; }

    const d = cfg.database;
    const env = {
      ...process.env,
      MOCHA_SERVER_URL: `https://0.0.0.0:${cfg.gamePort}`,
      REVERIE_TLS_CERT: TLS_CERT,
      REVERIE_PUBLIC_URL: publicUrl(cfg),
      MOCHA_PG_HOST: d.host, MOCHA_PG_PORT: String(d.port), MOCHA_PG_DATABASE: d.name, MOCHA_PG_USER: d.user, MOCHA_PG_PASSWORD: d.password,
      IP_HASH_SECRET: cfg.secrets.ipHash, JWT_SECRET: cfg.secrets.jwt, PHOTON_CUSTOM_AUTH_SECRET: cfg.secrets.photonAuth,
      REVERIE_ADMIN_KEY: cfg.secrets.adminKey,
      PHOTON_REALTIME_APP_ID: cfg.photon.realtimeAppId, PHOTON_VOICE_APP_ID: cfg.photon.voiceAppId, PHOTON_REGION: cfg.photon.region,
    };
    this.game.state = 'starting';
    this.log('reverie', `Starting game server (${cmd.kind}) on port ${cfg.gamePort}...`);
    const proc = spawn(cmd.cmd, cmd.args, { cwd: SERVER_DIR, env, windowsHide: true });
    this.game.proc = proc;
    fs.writeFileSync(SERVER_PID, String(proc.pid));
    proc.stdout.on('data', b => {
      this.log('server', b);
      if (this.game.state === 'starting' && /Server listening on/.test(b)) {
        this.game.state = 'running';
        this.game.startedAt = Date.now();
        this.emit('state');
      }
    });
    proc.stderr.on('data', b => this.log('server', b, 'error'));
    proc.on('error', e => this.log('reverie', `Could not launch the server: ${e.message}`, 'error'));
    proc.on('exit', code => {
      fs.rmSync(SERVER_PID, { force: true });
      const expected = this.game.state === 'stopping';
      this.game = { state: expected ? 'stopped' : 'crashed', proc: null, startedAt: null };
      this.log('reverie', expected ? 'Game server stopped.' : `Game server exited unexpectedly (code ${code}).`, expected ? 'info' : 'error');
      if (!expected && !this.problem) this.setProblem('The game server stopped unexpectedly. Check the log for the first error.');
      this.emit('state');
    });
    this.emit('state');
  }

  async stop() {
    const proc = this.game.proc;
    if (proc) {
      this.game.state = 'stopping';
      this.emit('state');
      proc.stdin.write('exit\n');
      const exited = await waitExit(proc, 20000);
      if (!exited) { this.log('reverie', 'Server did not stop in time; forcing it.', 'warn'); proc.kill(); await waitExit(proc, 5000); }
    }
    await this.stopDb();
  }

  async stopDb() {
    const proc = this.db.proc;
    if (!proc) { if (this.db.state === 'external') this.db.state = 'stopped'; return; }
    this.db.state = 'stopping';
    const bin = postgresBin(this.getConfig());
    spawnSync(pgTool(bin, 'pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast', '-w'], { windowsHide: true, stdio: 'ignore', timeout: 20000 });
    if (!(await waitExit(proc, 5000))) proc.kill();
  }

  // Runs one of Mocha's own console commands and returns what it printed.
  command(line, wait = 1500) {
    if (!this.game.proc || this.game.state !== 'running') return Promise.reject(new Error('Start the server first.'));
    return new Promise(resolve => {
      const out = [];
      const onLine = e => e.src === 'server' && out.push(e.text);
      this.on('line', onLine);
      this.game.proc.stdin.write(line.replace(/[\r\n]/g, ' ') + '\n');
      setTimeout(() => { this.off('line', onLine); resolve(out); }, wait);
    });
  }

  async api(pathname) {
    const cfg = this.getConfig();
    if (this.game.state !== 'running') return null;
    return new Promise((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port: cfg.gamePort, path: `/reverie/${pathname}`, ca: fs.readFileSync(TLS_PEM), headers: { 'X-Reverie-Key': cfg.secrets.adminKey }, timeout: 4000 }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (c) => { body += c; }).on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Server answered ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Server did not answer in time')));
      req.on('error', reject);
    });
  }

  snapshot() {
    return {
      database: this.db.state,
      server: this.game.state,
      startedAt: this.game.startedAt,
      problem: this.problem,
    };
  }
}

// A game server orphaned by a killed Reverie still holds the game port.
function killStale() {
  try {
    const pid = Number(fs.readFileSync(SERVER_PID, 'utf8'));
    const name = process.platform === 'win32'
      ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).stdout
      : fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (pid && /Mocha2023|dotnet/i.test(name)) process.kill(pid);
  } catch {}
  fs.rmSync(SERVER_PID, { force: true });
}

function waitExit(proc, ms) {
  if (proc.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}
