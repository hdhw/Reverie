import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATA = process.env.REVERIE_DATA || path.join(ROOT, 'data');
const FILE = path.join(DATA, 'config.json');

const secret = () => crypto.randomBytes(32).toString('base64url');

export const TLS_CERT = path.join(DATA, 'tls.pfx');
export const TLS_PEM = path.join(DATA, 'tls.pem');
export const publicUrl = (cfg) => (cfg.publicUrl || `https://localhost:${cfg.gamePort}`).replace(/\/+$/, '');
export const generateAdminName = () => `Reverie User#${crypto.randomInt(10000, 100000)}`;

// Mocha's own Photon apps, so a new server has working rooms before the host makes their own.
export const SHARED_PHOTON = { realtimeAppId: '94e5bc5c-d19b-4651-b3c0-e0f7758c17e1', voiceAppId: 'bfa91264-1580-4e63-b355-77404b95e33e', region: 'us' };

function defaults() {
  return {
    setupComplete: false,
    adminName: generateAdminName(),
    adminPasswordHash: null,
    serverName: 'My Reverie Server',
    gamePort: 5480,
    panelPort: 5481,
    panelLan: false,
    publicUrl: '',
    autoStart: true,
    database: { mode: 'managed', host: '127.0.0.1', port: 5482, name: 'reverie', user: 'reverie', password: secret() },
    pgBin: '',
    motd: '',
    photon: { ...SHARED_PHOTON },
    secrets: { ipHash: secret(), jwt: secret(), photonAuth: secret(), adminKey: secret() },
  };
}

function merge(base, over) {
  for (const [k, v] of Object.entries(over ?? {})) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return base;
}

export function load() {
  fs.mkdirSync(DATA, { recursive: true });
  const exists = fs.existsSync(FILE);
  const cfg = merge(defaults(), exists ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {});
  // Persist on first run so the generated admin name and secrets survive restarts.
  if (!exists) save(cfg);
  return cfg;
}

export function save(cfg) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, FILE);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(password, salt, 32).toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function validate(cfg) {
  const problems = [];
  const port = (name, v) => {
    if (!Number.isInteger(v) || v < 1 || v > 65535) problems.push(`${name} must be a whole number between 1 and 65535.`);
  };
  if (!String(cfg.adminName).trim() || String(cfg.adminName).length > 40) problems.push('Administrator name must be 1-40 characters.');
  if (!String(cfg.serverName).trim() || String(cfg.serverName).length > 60) problems.push('Server name must be 1-60 characters.');
  port('Game port', cfg.gamePort);
  port('Panel port', cfg.panelPort);
  port('Database port', cfg.database.port);
  if (new Set([cfg.gamePort, cfg.panelPort, cfg.database.mode === 'managed' ? cfg.database.port : -1]).size < 3)
    problems.push('The game, panel and database ports must all be different.');
  if (cfg.publicUrl && !/^https?:\/\/[^\s/]+/i.test(cfg.publicUrl)) problems.push('Public address must start with http:// or https://');
  if (cfg.database.mode === 'external' && (!cfg.database.host || !cfg.database.user || !cfg.database.name))
    problems.push('An existing database needs a host, database name and user.');
  return problems;
}
