import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT } from './config.mjs';

const EXE = process.platform === 'win32' ? '.exe' : '';
export const SERVER_DIR = path.join(ROOT, 'server');
export const RUNTIME = path.join(ROOT, 'runtime');
const PG_ZIP = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip';

export function dotnetRuntime() {
  const r = spawnSync('dotnet', ['--list-runtimes'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').find(l => l.startsWith('Microsoft.AspNetCore.App 8.'))?.split(' ')[1] ?? null;
}

// A self-contained publish needs no .NET install; a plain build needs the ASP.NET Core 8 runtime.
export function serverCommand() {
  const published = path.join(SERVER_DIR, 'publish', `Mocha2023${EXE}`);
  if (fs.existsSync(published)) return { cmd: published, args: [], kind: 'published' };
  const dll = path.join(SERVER_DIR, 'bin', 'Release', 'net8.0', 'Mocha2023.dll');
  if (fs.existsSync(dll)) return { cmd: 'dotnet', args: [dll], kind: 'dotnet', needsRuntime: true };
  return null;
}

export function postgresBin(cfg) {
  const candidates = [cfg.pgBin, path.join(RUNTIME, 'pgsql', 'bin')];
  const pf = process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'PostgreSQL');
  if (pf && fs.existsSync(pf))
    candidates.push(...fs.readdirSync(pf).sort((a, b) => Number(b) - Number(a)).map(v => path.join(pf, v, 'bin')));
  if (process.platform !== 'win32')
    candidates.push('/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return candidates.find(dir => dir && ['initdb', 'postgres', 'pg_dump'].every(b => fs.existsSync(path.join(dir, b + EXE)))) ?? null;
}

export const pgTool = (bin, name) => path.join(bin, name + EXE);

const bindable = (port, host) => new Promise(resolve => {
  const s = net.createServer().once('error', () => resolve(false))
    .once('listening', () => s.close(() => resolve(true))).listen(port, host);
});

// Windows lets 0.0.0.0 bind while something holds 127.0.0.1, so the default checks both.
export async function portFree(port, host) {
  if (host) return bindable(port, host);
  return await bindable(port, '127.0.0.1') && await bindable(port, '0.0.0.0');
}

export function portOpen(port, host = '127.0.0.1', timeout = 1000) {
  return new Promise(resolve => {
    const s = net.connect({ port, host, timeout });
    const done = ok => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true)).once('error', () => done(false)).once('timeout', () => done(false));
  });
}

export async function downloadPostgres(onProgress) {
  if (process.platform !== 'win32')
    throw new Error('Automatic download is only available on Windows. Install PostgreSQL 16 or newer with your package manager, then press Check again.');
  fs.mkdirSync(RUNTIME, { recursive: true });
  const zip = path.join(RUNTIME, 'postgresql.zip');
  const res = await fetch(PG_ZIP);
  if (!res.ok) throw new Error(`The PostgreSQL download failed (HTTP ${res.status}). Check your internet connection and try again.`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', c => { got += c.length; onProgress?.(total ? got / total : 0); });
  await pipeline(body, fs.createWriteStream(zip));
  const tar = spawnSync('tar', ['-xf', zip, '-C', RUNTIME, 'pgsql/bin', 'pgsql/lib', 'pgsql/share'], { windowsHide: true, encoding: 'utf8' });
  fs.rmSync(zip, { force: true });
  if (tar.status !== 0) throw new Error(`PostgreSQL downloaded but could not be unpacked: ${tar.stderr || tar.error?.message}`);
  return path.join(RUNTIME, 'pgsql', 'bin');
}
