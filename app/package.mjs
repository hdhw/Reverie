import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/config.mjs';

const NODE_VERSION = 'v22.11.0';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const name = `reverie-${pkg.version}-win-x64`;
const dist = path.join(ROOT, 'dist');
const stage = path.join(dist, name);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });

if (process.platform !== 'win32') throw new Error('Packaging builds the Windows release; run it on Windows.');

run('dotnet', ['publish', 'server/Mocha2023.csproj', '-c', 'Release', '-r', 'win-x64', '-o', 'server/publish', '--self-contained', '-p:PublishSingleFile=false']);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const skipData = new Set(['APIS', 'Imports', 'Debug', 'DBs', 'DBBackups', 'AvatarItemsUnlocked', 'announcements.json']);
const copy = (from, to, filter) => fs.cpSync(path.join(ROOT, from), path.join(stage, to ?? from), { recursive: true, filter });
copy('app', 'app', (src) => !src.includes(`${path.sep}test`));
copy('vendor');
copy('server/publish');
copy('server/Data', 'server/Data', (src) => !skipData.has(path.relative(path.join(ROOT, 'server/Data'), src).split(path.sep)[0]));
for (const f of ['Start Reverie.cmd', 'package.json', 'README.md', 'LICENSE']) if (fs.existsSync(path.join(ROOT, f))) copy(f);

const nodeZip = path.join(dist, `node-${NODE_VERSION}-win-x64.zip`);
if (!fs.existsSync(nodeZip)) {
  const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`);
  if (!res.ok) throw new Error(`Node download failed: HTTP ${res.status}`);
  fs.writeFileSync(nodeZip, Buffer.from(await res.arrayBuffer()));
}
execFileSync('C:\\Windows\\System32\\tar.exe', ['-xf', nodeZip, '-C', stage]);
fs.renameSync(path.join(stage, `node-${NODE_VERSION}-win-x64`), path.join(stage, 'node'));

const zip = path.join(dist, `${name}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', zip, '-C', dist, name]);
console.log(`Wrote ${path.relative(ROOT, zip)} (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
