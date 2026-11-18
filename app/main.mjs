import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { load, DATA } from './lib/config.mjs';
import { Supervisor } from './lib/supervisor.mjs';
import { createPanel } from './lib/http.mjs';

const headless = process.argv.includes('--no-window');
const ctx = { cfg: load() };
ctx.sup = new Supervisor(() => ctx.cfg);
const server = createPanel(ctx);
const host = ctx.cfg.panelLan ? '0.0.0.0' : '127.0.0.1';
const base = `http://127.0.0.1:${ctx.cfg.panelPort}`;

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE'
    ? `Reverie could not start: port ${ctx.cfg.panelPort} is in use. Reverie may already be open, or another program is using that port.`
    : `Reverie could not start: ${e.message}`);
  process.exit(1);
});

server.listen(ctx.cfg.panelPort, host, async () => {
  const link = base + ctx.desktopLink();
  console.log(`Reverie is running. Web panel: ${base}`);
  if (headless) console.log(`Open this link within 10 minutes to sign in without a password:\n  ${link}`);
  else openWindow(link);
  if (ctx.cfg.setupComplete && ctx.cfg.autoStart) ctx.sup.start().catch(e => ctx.sup.log('reverie', e.message, 'error'));
});

ctx.sup.on('line', e => { if (e.level === 'error' || e.src === 'reverie') console.log(`[${e.src}] ${e.text}`); });

function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const win = pf.flatMap(p => [
    path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]);
  const unix = ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return (process.platform === 'win32' ? win : unix).find(f => fs.existsSync(f));
}

// Chromium app mode with its own profile gives Reverie a standalone window, and the
// process lives exactly as long as that window does.
function openWindow(url) {
  const browser = findBrowser();
  if (!browser) {
    console.log(`No Edge or Chrome found. Open this in any browser:\n  ${url}`);
    return;
  }
  const win = spawn(browser, [`--app=${url}`, `--user-data-dir=${path.join(DATA, 'window')}`, '--window-size=1180,800', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });
  win.on('exit', () => {
    if (ctx.sup.game.proc) console.log(`Window closed. The server keeps running; reopen the panel at ${base} or press Ctrl+C to stop.`);
    else shutdown();
  });
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Stopping Reverie...');
  await ctx.sup.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
