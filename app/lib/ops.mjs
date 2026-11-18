import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA, validate } from './config.mjs';
import { serverCommand, dotnetRuntime, postgresBin, pgTool, portFree, portOpen } from './deps.mjs';
import { catalogStatus } from './catalog.mjs';

export const BACKUPS = path.join(DATA, 'backups');
const SAFE_NAME = /^reverie-[\w-]+\.dump$/;

function pgRun(sup, tool, args) {
  const cfg = sup.getConfig();
  const bin = postgresBin(cfg);
  if (!bin) throw new Error('PostgreSQL tools were not found, so backups cannot run. Install PostgreSQL from Setup > Database.');
  const r = spawnSync(pgTool(bin, tool), args, { env: { ...process.env, ...sup.dbEnv(cfg) }, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `${tool} failed`).trim());
}

export function listBackups() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs.readdirSync(BACKUPS).filter(n => SAFE_NAME.test(n)).map(name => {
    const st = fs.statSync(path.join(BACKUPS, name));
    return { name, bytes: st.size, createdAt: st.mtimeMs };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

export function createBackup(sup, label = 'manual') {
  if (!['running', 'external'].includes(sup.db.state)) throw new Error('The database must be running to back it up. Start the server first.');
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `reverie-${stamp}-${label.replace(/\W/g, '')}.dump`;
  pgRun(sup, 'pg_dump', ['-Fc', '-f', path.join(BACKUPS, name)]);
  return name;
}

export async function restoreBackup(sup, name) {
  if (!SAFE_NAME.test(name) || !fs.existsSync(path.join(BACKUPS, name))) throw new Error('That backup does not exist.');
  if (sup.game.proc) throw new Error('Stop the game server before restoring a backup.');
  const startedDb = !['running', 'external'].includes(sup.db.state);
  if (startedDb) await sup.startDb();
  try {
    createBackup(sup, 'before-restore');
    pgRun(sup, 'pg_restore', ['--clean', '--if-exists', '--no-owner', '-d', sup.getConfig().database.name, path.join(BACKUPS, name)]);
  } finally {
    if (startedDb) await sup.stopDb();
  }
}

// Each check: ok | warn | fail, plus a plain-language fix.
export async function diagnostics(sup) {
  const cfg = sup.getConfig();
  const out = [];
  const add = (name, status, detail, fix = null) => out.push({ name, status, detail, fix });
  const running = sup.game.state === 'running';

  const problems = validate(cfg);
  add('Configuration', problems.length ? 'fail' : 'ok', problems.length ? problems.join(' ') : 'All settings look valid.');

  const cmd = serverCommand();
  if (!cmd) add('Game server files', 'fail', 'The server has not been built.', 'Run "npm run build" in the Reverie folder.');
  else add('Game server files', 'ok', cmd.kind === 'published' ? 'Self-contained build found.' : 'Development build found.');

  if (cmd?.needsRuntime) {
    const rt = dotnetRuntime();
    add('.NET runtime', rt ? 'ok' : 'fail', rt ? `ASP.NET Core ${rt}` : 'ASP.NET Core 8 runtime not found.', rt ? null : 'Install "ASP.NET Core Runtime 8" from dotnet.microsoft.com.');
  }

  if (cfg.database.mode === 'managed') {
    const bin = postgresBin(cfg);
    add('PostgreSQL', bin ? 'ok' : 'fail', bin ? `Using ${bin}` : 'Not installed.', bin ? null : 'Open Setup > Database and press Download.');
  } else {
    const up = await portOpen(cfg.database.port, cfg.database.host, 3000);
    add('PostgreSQL', up ? 'ok' : 'fail', up ? `Reachable at ${cfg.database.host}:${cfg.database.port}` : `Nothing answering at ${cfg.database.host}:${cfg.database.port}.`, up ? null : 'Start your PostgreSQL server or check the host and port.');
  }

  if (!running) {
    const free = await portFree(cfg.gamePort);
    add(`Game port ${cfg.gamePort}`, free ? 'ok' : 'fail', free ? 'Free.' : 'In use by another program.', free ? null : 'Close the other program or choose another game port.');
    if (cfg.database.mode === 'managed' && !sup.db.proc) {
      const dbFree = await portFree(cfg.database.port, '127.0.0.1');
      add(`Database port ${cfg.database.port}`, dbFree ? 'ok' : 'fail', dbFree ? 'Free.' : 'In use by another program.', dbFree ? null : 'Choose another database port in Settings.');
    }
  } else {
    try {
      const s = await sup.api('status');
      add('Server responding', 'ok', `${s.players} players, ${s.online} online, ${s.rooms} rooms.`);
    } catch (e) {
      add('Server responding', 'fail', `The server is running but not answering (${e.message}).`, 'Restart the server. If it keeps happening, check the log.');
    }
  }

  const photon = cfg.photon.realtimeAppId && cfg.photon.voiceAppId;
  add('Multiplayer (Photon)', photon ? 'ok' : 'warn', photon ? `Region ${cfg.photon.region}` : 'No Photon App IDs set. Players can sign in, but rooms will not connect.', photon ? null : 'Create a free Photon PUN and Voice app at dashboard.photonengine.com and paste the App IDs into Settings.');

  const missing = catalogStatus().filter(c => !c.present);
  add('Game data', missing.length ? 'warn' : 'ok', missing.length ? `${missing.length} data files will be installed on next start.` : 'Avatar items, equipment, consumables, game configs and base rooms are installed.');

  return out;
}
