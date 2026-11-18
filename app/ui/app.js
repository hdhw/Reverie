const root = document.getElementById('root');
const dialog = document.getElementById('dialog');
let cfg = null;
let timers = [];

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = root) => el.querySelector(sel);
const $$ = (sel, el = root) => [...el.querySelectorAll(sel)];

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reverie': '1' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Session expired mid-use: drop back to sign-in once (boot itself probes /api/config).
  if (res.status === 401 && cfg && path !== '/api/login') { cfg = null; boot(); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 4500);
}

function every(ms, fn) { fn(); timers.push(setInterval(fn, ms)); }
function clearTimers() { timers.forEach(clearInterval); timers = []; }

const ago = ms => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const bytes = n => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`;
const when = ms => new Date(ms).toLocaleString();

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = label; }
}

/* ---------- boot ---------- */
async function boot() {
  clearTimers();
  try {
    cfg = await api('/api/config');
  } catch {
    const hello = await fetch('/api/hello').then(r => r.json());
    return hello.setupComplete ? signIn(hello) : notAllowed();
  }
  if (!cfg.setupComplete) return wizard();
  window.onhashchange = () => shell();
  shell();
}

function notAllowed() {
  root.innerHTML = `<div class="signin"><div><div class="brand"><img src="/mark.svg" alt="">Reverie</div>
    <h2>Finish setup on the host computer</h2><p class="muted">Setup has to be done from the Reverie window on the computer running the server.</p></div></div>`;
}

function signIn(hello) {
  root.innerHTML = `<div class="signin"><form>
    <div class="brand"><img src="/mark.svg" alt="">Reverie</div>
    <h2>Sign in to ${esc(hello.serverName)}</h2>
    <div class="field"><label for="u">Administrator name</label><input id="u" type="text" autocomplete="username" required></div>
    <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
    <p class="error-text hidden" id="err"></p>
    <button class="primary" type="submit">Sign in</button></form></div>`;
  $('form').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/login', { username: $('#u').value, password: $('#p').value }); boot(); }
    catch (err) { $('#err').textContent = err.message; $('#err').classList.remove('hidden'); }
  };
}

/* ---------- setup wizard ---------- */
const STEPS = ['Welcome', 'How it works', 'Your identity', 'Server name', 'Database', 'Server settings', 'Final checks', 'Launch'];
let step = Number(sessionStorage.getItem('reverie-step') || 0);

function wizard() {
  const done = i => i < step ? 'done' : i === step ? 'current' : '';
  root.innerHTML = `<div class="wizard">
    <aside class="steps"><div class="brand"><img src="/mark.svg" alt="">Reverie</div>
      <ol>${STEPS.map((s, i) => `<li class="${done(i)}" ${i === step ? 'aria-current="step"' : ''}>${s}</li>`).join('')}</ol></aside>
    <section class="stage"></section></div>`;
  const stage = $('.stage');
  const go = n => { step = Math.max(0, Math.min(STEPS.length - 1, n)); sessionStorage.setItem('reverie-step', step); wizard(); };
  const nav = (nextLabel = 'Continue', back = true) =>
    `<div class="nav">${back ? '<button type="button" data-back>Back</button>' : ''}<button class="primary" type="submit">${nextLabel}</button></div>`;
  const form = (html, onNext) => {
    stage.innerHTML = `<form>${html}<p class="error-text hidden" id="err"></p></form>`;
    $('[data-back]', stage)?.addEventListener('click', () => go(step - 1));
    $('form', stage).onsubmit = async e => {
      e.preventDefault();
      try { await onNext?.(); go(step + 1); }
      catch (err) { $('#err').textContent = err.message; $('#err').classList.remove('hidden'); }
    };
  };
  const saveCfg = async body => { cfg = (await api('/api/config', body)).config; };

  [
    () => form(`<h1>Welcome to Reverie</h1>
      <p class="lede">Reverie runs your own Rec Room revival server on this computer. You choose who plays, what they wear, and when the lights are on.</p>
      <p>Setup takes about five minutes. You can change everything later.</p>${nav('Get started', false)}`),

    () => form(`<h1>How a revival server works</h1>
      <p class="lede">Three pieces talk to each other.</p>
      <ul class="parts">
        <li><strong>This app</strong>Starts and stops everything, and keeps your settings and backups.</li>
        <li><strong>The game server</strong>Answers the game the way Rec Room's servers used to: accounts, avatars, rooms, friends. It is built on Mocha.</li>
        <li><strong>Your players' game</strong>An older Rec Room build, modded to connect to your server's address instead of Rec Room's.</li>
      </ul>
      <p>Reverie doesn't include Rec Room itself. Players bring their own copy.</p>
      <p>You also get a <strong>web panel</strong>: the screens you'll see after setup, available in any browser. Use it to watch players, read logs and make backups.</p>${nav()}`),

    () => {
      form(`<h1>Your administrator identity</h1>
        <p class="lede">This is how you sign in to the web panel. It isn't a Rec Room account, and players never see it.</p>
        <p class="muted">We picked a name for you:</p>
        <div class="generated" id="gen">${esc(cfg.adminName)}</div>
        <div class="row"><button type="button" id="regen">Pick another</button></div><br>
        <div class="field"><label for="name">Administrator name</label><input id="name" type="text" maxlength="40" value="${esc(cfg.adminName)}" required><small>Keep it or type your own.</small></div>
        <div class="field"><label for="pw">Panel password</label><input id="pw" type="password" autocomplete="new-password" minlength="8" ${cfg.hasPassword ? '' : 'required'}><small>${cfg.hasPassword ? 'A password is already set. Leave blank to keep it.' : 'At least 8 characters.'}</small></div>
        <div class="field"><label for="pw2">Confirm password</label><input id="pw2" type="password" autocomplete="new-password"></div>${nav()}`,
      async () => {
        const pw = $('#pw').value;
        if (pw !== $('#pw2').value) throw new Error('The passwords don\'t match.');
        await saveCfg({ adminName: $('#name').value, ...(pw ? { password: pw } : {}) });
      });
      $('#regen').onclick = async () => { cfg = await api('/api/setup/regenerate-name', {}); $('#gen').textContent = cfg.adminName; $('#name').value = cfg.adminName; };
    },

    () => form(`<h1>Name your server</h1>
      <p class="lede">Shown on the panel and sign-in page.</p>
      <div class="field"><label for="sn">Server name</label><input id="sn" type="text" maxlength="60" value="${esc(cfg.serverName)}" required></div>${nav()}`,
      () => saveCfg({ serverName: $('#sn').value })),

    () => databaseStep(stage, form, nav, saveCfg),

    () => form(`<h1>Server settings</h1>
      <p class="lede">The defaults work for playing on this computer or your home network.</p>
      <div class="field"><label for="gp">Game server port</label><input id="gp" type="number" min="1" max="65535" value="${cfg.gamePort}"><small>Players' games connect here.</small></div>
      <div class="field"><label for="url">Public address <span class="muted">(optional)</span></label><input id="url" type="text" placeholder="https://play.example.com" value="${esc(cfg.publicUrl)}"><small>Only needed if players connect over the internet, for example through a tunnel or domain. Images and links use it.</small></div>
      <h3>Multiplayer</h3>
      <p class="muted">Rec Room rooms run on Photon. Create a free <strong>PUN</strong> app and a <strong>Voice</strong> app at <a href="https://dashboard.photonengine.com" target="_blank" rel="noopener">dashboard.photonengine.com</a> and paste their App IDs. You can skip this for now, but players won't be able to enter rooms until it's set.</p>
      <div class="field"><label for="pr">Photon PUN App ID</label><input id="pr" type="text" class="mono" value="${esc(cfg.photon.realtimeAppId)}"></div>
      <div class="field"><label for="pv">Photon Voice App ID</label><input id="pv" type="text" class="mono" value="${esc(cfg.photon.voiceAppId)}"></div>
      <div class="field"><label for="reg">Photon region</label><select id="reg">${['us', 'usw', 'eu', 'asia', 'jp', 'au', 'sa', 'kr', 'in'].map(r => `<option ${r === cfg.photon.region ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <h3>Web panel</h3>
      <div class="field"><label class="check"><input type="checkbox" id="lan" ${cfg.panelLan ? 'checked' : ''}><span>Let other devices on my network open the web panel<br><small>Off: only this computer can open it. Takes effect next time Reverie opens.</small></span></label></div>
      ${nav()}`,
      () => saveCfg({ gamePort: Number($('#gp').value), publicUrl: $('#url').value, panelLan: $('#lan').checked,
        photon: { realtimeAppId: $('#pr').value, voiceAppId: $('#pv').value, region: $('#reg').value } })),

    () => {
      form(`<h1>Final checks</h1><p class="lede">Making sure everything is in place before the first start.</p>
        <ul class="checks" id="checks"><li class="empty">Checking...</li></ul>
        <div class="row"><button type="button" id="again">Check again</button></div>${nav('Continue')}`,
      async () => {
        const fails = (await api('/api/diagnostics')).filter(c => c.status === 'fail');
        if (fails.length) throw new Error(`Fix ${fails.length === 1 ? 'the problem' : 'the problems'} above first.`);
        await api('/api/setup/complete', {});
      });
      const run = async () => renderChecks($('#checks'), await api('/api/diagnostics'));
      $('#again').onclick = run;
      run();
    },

    () => {
      stage.innerHTML = `<h1>You're ready</h1>
        <p class="lede">Start your server for the first time. The first start creates the database, so it can take a minute.</p>
        <div class="row"><button class="primary" id="launch">Start server</button></div>
        <div class="log short" id="log" hidden></div>
        <p class="error-text hidden" id="err"></p>
        <div id="after" class="hidden"><h2>Meet the web panel</h2>
          <p>Everything from here on happens in the panel: this window, or any browser at <a href="http://127.0.0.1:${cfg.panelPort}" target="_blank" rel="noopener">http://127.0.0.1:${cfg.panelPort}</a>. Sign in as <strong>${esc(cfg.adminName)}</strong>.</p>
          <button class="primary" id="open">Open the panel</button></div>`;
      $('#launch').onclick = e => busy(e.target, async () => {
        $('#log').hidden = false;
        let since = 0;
        const tail = setInterval(async () => {
          const lines = await api(`/api/logs?since=${since}`).catch(() => []);
          if (lines.length) { since = lines.at(-1).id; appendLog($('#log'), lines); }
        }, 800);
        try {
          await api('/api/server/start', {});
          for (let i = 0; i < 120; i++) {
            const o = await api('/api/overview');
            if (o.server === 'running') break;
            if (o.server === 'crashed') throw new Error(o.problem?.message || 'The server stopped while starting. The log above shows why.');
            await new Promise(r => setTimeout(r, 1000));
          }
          $('#after').classList.remove('hidden');
          e.target.classList.add('hidden');
        } catch (err) { $('#err').textContent = err.message; $('#err').classList.remove('hidden'); }
        finally { setTimeout(() => clearInterval(tail), 2000); }
      });
      $('#open').onclick = () => { sessionStorage.removeItem('reverie-step'); location.hash = '#overview'; boot(); };
    },
  ][step]();
}

async function databaseStep(stage, form, nav, saveCfg) {
  const deps = await api('/api/deps');
  const d = cfg.database;
  form(`<h1>Database</h1>
    <p class="lede">Reverie keeps accounts, rooms and inventories in PostgreSQL.</p>
    <label class="choice"><input type="radio" name="mode" value="managed" ${d.mode === 'managed' ? 'checked' : ''}> <strong>Let Reverie handle it (recommended)</strong>
      <span class="muted">A private database stored in Reverie's data folder. Nothing to configure.</span></label>
    <label class="choice"><input type="radio" name="mode" value="external" ${d.mode === 'external' ? 'checked' : ''}> <strong>Use my own PostgreSQL server</strong>
      <span class="muted">For people who already run one.</span></label>
    <div id="managed">
      <h3>PostgreSQL</h3>
      <p id="pgstate">${deps.postgres ? `Found at <code>${esc(deps.postgres)}</code>.` : 'PostgreSQL isn\'t installed on this computer.'}</p>
      ${deps.postgres ? '' : deps.platform === 'win32'
        ? `<button type="button" id="dl">Download PostgreSQL (about 340 MB)</button><div class="progress hidden" id="prog"><div></div></div>`
        : '<p class="muted">Install PostgreSQL 16 or newer with your package manager, then press Check again.</p>'}
      <div class="field"><label for="dbp">Database port</label><input id="dbp" type="number" value="${d.port}"><small>Only used on this computer.</small></div>
    </div>
    <div id="external">
      <div class="field"><label for="dh">Host</label><input id="dh" type="text" value="${esc(d.host)}"></div>
      <div class="field"><label for="dport">Port</label><input id="dport" type="number" value="${d.port}"></div>
      <div class="field"><label for="dn">Database name</label><input id="dn" type="text" value="${esc(d.name)}"></div>
      <div class="field"><label for="du">User</label><input id="du" type="text" value="${esc(d.user)}"></div>
      <div class="field"><label for="dpw">Password</label><input id="dpw" type="password" value="${esc(d.password || '')}"></div>
      <div class="field"><label for="pgbin">PostgreSQL tools folder <span class="muted">(optional, for backups)</span></label><input id="pgbin" type="text" value="${esc(cfg.pgBin)}"></div>
    </div>
    <h3>Game server</h3>
    <p>${deps.server === 'published' ? 'Ready.' : deps.server === 'dotnet'
      ? (deps.dotnet ? `Ready (ASP.NET Core ${esc(deps.dotnet)}).` : '<span class="error-text">Needs the ASP.NET Core 8 runtime.</span> Install it from <a href="https://dotnet.microsoft.com/download/dotnet/8.0" target="_blank" rel="noopener">dotnet.microsoft.com</a>, then press Check again.')
      : '<span class="error-text">Not built yet.</span> Run <code>npm run build</code> in the Reverie folder.'}</p>
    <div class="row"><button type="button" id="recheck">Check again</button></div>
    ${nav()}`,
  async () => {
    const mode = $('input[name=mode]:checked').value;
    if (mode === 'managed' && !(await api('/api/deps')).postgres) throw new Error('Download PostgreSQL first, or choose your own server.');
    await saveCfg(mode === 'managed'
      ? { database: { mode, port: Number($('#dbp').value) } }
      : { pgBin: $('#pgbin').value, database: { mode, host: $('#dh').value, port: Number($('#dport').value), name: $('#dn').value, user: $('#du').value, password: $('#dpw').value } });
  });
  const sync = () => {
    const ext = $('input[name=mode]:checked').value === 'external';
    $('#managed').classList.toggle('hidden', ext);
    $('#external').classList.toggle('hidden', !ext);
  };
  $$('input[name=mode]').forEach(r => r.onchange = sync);
  sync();
  $('#recheck').onclick = () => wizard();
  const dl = $('#dl');
  if (dl) {
    const watch = () => {
      $('#prog').classList.remove('hidden');
      dl.disabled = true;
      const t = setInterval(async () => {
        const s = (await api('/api/deps')).download;
        $('#prog div').style.width = `${Math.round(s.progress * 100)}%`;
        dl.textContent = s.progress >= 1 ? 'Unpacking...' : `Downloading ${Math.round(s.progress * 100)}%`;
        if (!s.active) {
          clearInterval(t);
          if (s.error) { toast(s.error); dl.disabled = false; dl.textContent = 'Try the download again'; } else wizard();
        }
      }, 700);
    };
    if (deps.download.active) watch();
    dl.onclick = async () => { await api('/api/deps/postgres', {}); watch(); };
  }
}

function renderChecks(ul, checks) {
  const icon = { ok: '✓', warn: '!', fail: '✕' };
  ul.innerHTML = checks.map(c => `<li><span class="icon ${c.status}" aria-label="${c.status}">${icon[c.status]}</span>
    <div><strong>${esc(c.name)}</strong><br><span class="muted">${esc(c.detail)}</span></div>
    ${c.fix ? `<span class="fix">${esc(c.fix)}</span>` : ''}</li>`).join('');
}

function appendLog(el, lines) {
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.insertAdjacentHTML('beforeend', lines.map(l =>
    `<div class="l-${l.level}"><span class="src">${new Date(l.t).toLocaleTimeString()} ${esc(l.src)}</span> ${esc(l.text)}</div>`).join(''));
  while (el.childElementCount > 2000) el.firstElementChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}

/* ---------- dashboard ---------- */
const PAGES = { overview: 'Overview', players: 'Players', logs: 'Logs', backups: 'Backups', settings: 'Settings', compatibility: 'Clients', diagnostics: 'Diagnostics' };

function shell() {
  clearTimers();
  const page = location.hash.slice(1) in PAGES ? location.hash.slice(1) : 'overview';
  root.innerHTML = `<div class="shell"><nav class="rail" aria-label="Main">
      <div class="brand"><img src="/mark.svg" alt="">Reverie</div>
      ${Object.entries(PAGES).map(([k, v]) => `<a href="#${k}" ${k === page ? 'aria-current="page"' : ''}>${v}</a>`).join('')}
      <div class="foot">${esc(cfg.adminName)}<br><button id="signout">Sign out</button></div>
    </nav><main></main></div>`;
  $('#signout').onclick = async () => { await api('/api/logout', {}); boot(); };
  ({ overview, players, logs, backups, settings, compatibility, diagnostics: diagnosticsPage })[page]($('main'));
}

const LINES = {
  running: 'Your server is awake.', stopped: 'Your server is asleep.', starting: 'Waking up...',
  stopping: 'Going to sleep...', crashed: 'Your server stopped unexpectedly.',
};

function overview(main) {
  main.innerHTML = `<p class="muted">${esc(cfg.serverName)}</p>
    <h1 class="status-line" data-state="stopped"><span class="dot"></span><span id="line">...</span></h1>
    <div class="row" id="controls"></div>
    <div id="problem"></div>
    <div class="stats" id="stats"></div>
    <dl class="addresses">
      <dt>Game server address</dt><dd><code>${esc(cfg.publicUrl || `http://<this computer's IP>:${cfg.gamePort}`)}</code></dd>
      <dt>Web panel</dt><dd><code>http://${cfg.panelLan ? '<this computer\'s IP>' : '127.0.0.1'}:${cfg.panelPort}</code></dd>
      <dt>Database</dt><dd id="dbstate">...</dd>
    </dl>
    <h2>Recent activity</h2><div class="log short" id="log"></div>`;
  let since = 0, last = '';
  every(2000, async () => {
    const o = await api('/api/overview').catch(() => null);
    if (!o) return;
    $('.status-line').dataset.state = o.server;
    $('#line').textContent = LINES[o.server] ?? o.server;
    if (last !== o.server) {
      last = o.server;
      const up = o.server === 'running', moving = o.server === 'starting' || o.server === 'stopping';
      $('#controls').innerHTML = up
        ? '<button id="stop">Stop server</button><button id="restart">Restart</button>'
        : `<button class="primary" id="start" ${moving ? 'disabled' : ''}>Start server</button>`;
      const act = (id, path) => $(id) && ($(id).onclick = e => busy(e.target, () => api(path, {})));
      act('#start', '/api/server/start'); act('#stop', '/api/server/stop'); act('#restart', '/api/server/restart');
    }
    $('#problem').innerHTML = o.problem ? `<div class="banner"><p><strong>${esc(o.problem.message)}</strong></p>${o.problem.detail ? `<details><summary>Technical detail</summary><code>${esc(o.problem.detail)}</code></details>` : ''}</div>` : '';
    const s = o.stats;
    $('#stats').innerHTML = [
      [s ? s.online : '–', 'players online'], [s ? s.players : '–', 'accounts'], [s ? s.rooms : '–', 'rooms'],
      [o.startedAt ? ago(o.startedAt) : '–', 'uptime'],
    ].map(([b, t]) => `<div class="stat"><b>${b}</b><span>${t}</span></div>`).join('');
    if (s && !s.photonConfigured && !$('#problem').innerHTML)
      $('#problem').innerHTML = '<div class="banner warn"><p>Multiplayer isn\'t set up, so players can\'t enter rooms. Add your Photon App IDs in <a href="#settings">Settings</a>.</p></div>';
    $('#dbstate').textContent = { running: 'Running (managed by Reverie)', external: 'Your own PostgreSQL server', stopped: 'Not running', starting: 'Starting', crashed: 'Stopped unexpectedly', stopping: 'Stopping' }[o.database] ?? o.database;
    const lines = await api(`/api/logs?since=${since}`).catch(() => []);
    if (lines.length) { since = lines.at(-1).id; appendLog($('#log'), lines.slice(-200)); }
  });
}

function players(main) {
  main.innerHTML = `<div class="pagehead"><div><h1>Players</h1><p class="muted">Everyone with an account on this server. Online players are listed first.</p></div>
    <input type="search" id="q" placeholder="Search by name or id" aria-label="Search players"></div><div id="list"></div>`;
  const load = async () => {
    try {
      const rows = await api(`/api/players?q=${encodeURIComponent($('#q').value)}`);
      $('#list').innerHTML = rows.length ? `<table class="players-table"><thead><tr><th>Player</th><th>Status</th><th class="opt">Level</th><th class="opt">Last seen</th><th></th></tr></thead><tbody>
        ${rows.map(p => `<tr><td><strong>${esc(p.displayName || p.username)}</strong><br><span class="muted">@${esc(p.username)}, #${p.id}</span></td>
          <td>${p.banned ? '<span class="pill bad">Banned</span>' : p.online ? '<span class="pill ok">Online</span>' : '<span class="pill">Offline</span>'}</td>
          <td class="opt">${p.level ?? ''}</td><td class="opt">${p.lastLoginAt ? when(Date.parse(p.lastLoginAt)) : ''}</td>
          <td><button data-id="${p.id}" data-name="${esc(p.displayName || p.username)}" data-banned="${p.banned}">Manage</button></td></tr>`).join('')}
        </tbody></table>` : `<p class="empty">${$('#q').value ? 'No players match that search.' : 'No accounts yet. They appear here when someone first signs in from their game.'}</p>`;
      $$('[data-id]').forEach(b => b.onclick = () => managePlayer(b.dataset, load));
    } catch (e) { $('#list').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  };
  let t;
  $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  load();
}

function managePlayer({ id, name, banned }, reload) {
  const opts = [
    banned === 'true' ? ['unban', 'Lift ban', null] : ['ban', 'Ban', 'Hours (leave blank for permanent)'],
    ['set-tokens', 'Set token balance', 'Tokens'], ['set-display', 'Change display name', 'Display name'],
    ['set-level', 'Set level', 'Level'], ['give-rrplus', 'Give RR+', null], ['reset-password', 'Reset password', null],
  ];
  dialog.innerHTML = `<form method="dialog"><h2>${esc(name)}</h2><p class="muted">Player #${esc(id)}</p>
    <div class="field"><label for="act">Action</label><select id="act">${opts.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    <div class="field" id="valwrap"><label for="val" id="vallabel"></label><input id="val" type="text"></div>
    <pre class="log short hidden" id="out"></pre>
    <div class="row"><button type="button" class="primary" id="apply">Apply</button><button value="close">Close</button></div></form>`;
  const sync = () => {
    const o = opts.find(x => x[0] === $('#act', dialog).value);
    $('#valwrap', dialog).classList.toggle('hidden', !o[2]);
    $('#vallabel', dialog).textContent = o[2] ?? '';
  };
  $('#act', dialog).onchange = sync;
  sync();
  $('#apply', dialog).onclick = e => busy(e.target, async () => {
    const r = await api('/api/players/action', { id: Number(id), action: $('#act', dialog).value, value: $('#val', dialog).value });
    const out = $('#out', dialog);
    out.textContent = r.output.join('\n') || 'Sent. The server printed nothing back.';
    out.classList.remove('hidden');
    reload();
  });
  dialog.showModal();
}

function logs(main) {
  main.innerHTML = `<div class="pagehead"><div><h1>Logs</h1><p class="muted">Live output from Reverie, the game server and the database.</p></div></div>
    <div class="logbar"><select id="src" aria-label="Source"><option value="">All sources</option><option>server</option><option>database</option><option>reverie</option></select>
      <label class="check"><input type="checkbox" id="errs"> Errors only</label></div>
    <div class="log" id="log" tabindex="0"></div>`;
  let all = [];
  const render = () => {
    const src = $('#src').value, errs = $('#errs').checked;
    $('#log').innerHTML = '';
    appendLog($('#log'), all.filter(l => (!src || l.src === src) && (!errs || l.level === 'error')));
  };
  $('#src').onchange = render; $('#errs').onchange = render;
  let since = 0;
  every(1500, async () => {
    const lines = await api(`/api/logs?since=${since}`).catch(() => []);
    if (!lines.length) return;
    since = lines.at(-1).id;
    all = all.concat(lines).slice(-3000);
    const src = $('#src').value, errs = $('#errs').checked;
    appendLog($('#log'), lines.filter(l => (!src || l.src === src) && (!errs || l.level === 'error')));
  });
}

function backups(main) {
  main.innerHTML = `<div class="pagehead"><div><h1>Backups</h1><p class="muted">Snapshots of the whole database: accounts, rooms, inventories. Stored in Reverie's <code>data/backups</code> folder.</p></div>
    <button class="primary" id="make">Back up now</button></div><div id="list"></div>`;
  const load = async () => {
    const rows = await api('/api/backups');
    $('#list').innerHTML = rows.length ? `<table><thead><tr><th>Backup</th><th>Size</th><th></th></tr></thead><tbody>
      ${rows.map(b => `<tr><td>${when(b.createdAt)}<br><span class="muted mono">${esc(b.name)}</span></td><td>${bytes(b.bytes)}</td>
        <td><button data-name="${esc(b.name)}">Restore</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">No backups yet. Back up before big changes, like importing rooms or updating Reverie.</p>';
    $$('[data-name]').forEach(b => b.onclick = () => {
      dialog.innerHTML = `<form method="dialog"><h2>Restore this backup?</h2>
        <p>The database goes back to how it was on ${when(rows.find(r => r.name === b.dataset.name).createdAt)}. Anything newer is replaced. Reverie saves a backup of the current state first.</p>
        <p class="muted">Stop the server before restoring.</p>
        <div class="row"><button type="button" class="primary" id="yes">Restore backup</button><button value="close">Cancel</button></div></form>`;
      $('#yes', dialog).onclick = e => busy(e.target, async () => {
        await api('/api/backups/restore', { name: b.dataset.name });
        dialog.close(); toast('Backup restored.'); load();
      });
      dialog.showModal();
    });
  };
  $('#make').onclick = e => busy(e.target, async () => { await api('/api/backups', {}); toast('Backup created.'); load(); });
  load().catch(e => { $('#list').innerHTML = `<p class="empty">${esc(e.message)}</p>`; });
}

function settings(main) {
  const d = cfg.database;
  main.innerHTML = `<div class="pagehead"><div><h1>Settings</h1><p class="muted">Changes to ports, addresses, database or Photon apply after a server restart.</p></div></div>
    <form id="f">
      <h2>Identity</h2>
      <div class="field"><label for="sn">Server name</label><input id="sn" type="text" maxlength="60" value="${esc(cfg.serverName)}"></div>
      <div class="field"><label for="an">Administrator name</label><input id="an" type="text" maxlength="40" value="${esc(cfg.adminName)}"></div>
      <div class="field"><label for="pw">New panel password</label><input id="pw" type="password" autocomplete="new-password" placeholder="Leave blank to keep the current one"></div>
      <h2>Server</h2>
      <div class="field"><label for="gp">Game server port</label><input id="gp" type="number" value="${cfg.gamePort}"></div>
      <div class="field"><label for="url">Public address</label><input id="url" type="text" value="${esc(cfg.publicUrl)}" placeholder="https://play.example.com"></div>
      <div class="field"><label class="check"><input type="checkbox" id="auto" ${cfg.autoStart ? 'checked' : ''}> Start the server when Reverie opens</label></div>
      <h2>Multiplayer (Photon)</h2>
      <div class="field"><label for="pr">PUN App ID</label><input id="pr" type="text" class="mono" value="${esc(cfg.photon.realtimeAppId)}"></div>
      <div class="field"><label for="pv">Voice App ID</label><input id="pv" type="text" class="mono" value="${esc(cfg.photon.voiceAppId)}"></div>
      <div class="field"><label for="reg">Region</label><input id="reg" type="text" value="${esc(cfg.photon.region)}"></div>
      <details class="field"><summary>Optional: Photon custom authentication</summary>
        <p class="muted">Stops people joining your Photon rooms without signing in to your server. In the Photon dashboard, set the authentication URL to <code>${esc(cfg.photonAuth.url)}</code> and add a parameter <code>secret</code> with this value:</p>
        <code class="mono">${esc(cfg.photonAuth.secret)}</code><p class="muted">Your server must be reachable from the internet for this to work.</p></details>
      <h2>Web panel</h2>
      <div class="field"><label for="pp">Panel port</label><input id="pp" type="number" value="${cfg.panelPort}"></div>
      <div class="field"><label class="check"><input type="checkbox" id="lan" ${cfg.panelLan ? 'checked' : ''}> Let other devices on my network open the panel</label></div>
      <h2>Database</h2>
      <p>${d.mode === 'managed' ? `Managed by Reverie on port ${d.port}.` : `Your own PostgreSQL server at <code>${esc(d.host)}:${d.port}</code>, database <code>${esc(d.name)}</code>.`} <span class="muted">To change this, edit <code>data/config.json</code> while Reverie is closed.</span></p>
      <p class="error-text hidden" id="err"></p>
      <button class="primary" type="submit">Save settings</button>
    </form>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/api/config', {
        serverName: $('#sn').value, adminName: $('#an').value, ...($('#pw').value ? { password: $('#pw').value } : {}),
        gamePort: Number($('#gp').value), publicUrl: $('#url').value, autoStart: $('#auto').checked,
        panelPort: Number($('#pp').value), panelLan: $('#lan').checked,
        photon: { realtimeAppId: $('#pr').value, voiceAppId: $('#pv').value, region: $('#reg').value },
      });
      cfg = r.config;
      $('#err').classList.add('hidden');
      toast(['Settings saved.', r.restartServer && 'Restart the server to apply them.', r.restartApp && 'Panel changes apply next time Reverie opens.'].filter(Boolean).join(' '));
    } catch (err) { $('#err').textContent = err.message; $('#err').classList.remove('hidden'); }
  };
}

async function compatibility(main) {
  const c = await api('/api/compat');
  const tone = { tested: 'ok', upstream: 'warn', planned: '' };
  main.innerHTML = `<div class="pagehead"><div><h1>Clients</h1><p class="muted">${esc(c.note)}</p></div></div>
    <table><thead><tr><th>Era</th><th>Status</th><th>Notes</th></tr></thead><tbody>
    ${c.clients.map(x => `<tr><td><strong>${esc(x.era)}</strong>${x.builds.length ? `<br><span class="muted">${x.builds.map(esc).join(', ')}</span>` : ''}</td>
      <td><span class="pill ${tone[x.status]}" title="${esc(c.statuses[x.status])}">${{ tested: 'Tested', upstream: 'Worked on Mocha', planned: 'Planned' }[x.status]}</span></td>
      <td>${esc(x.notes)}</td></tr>`).join('')}</tbody></table>
    <p class="muted"><br>${Object.entries(c.statuses).map(([k, v]) => `<strong>${{ tested: 'Tested', upstream: 'Worked on Mocha', planned: 'Planned' }[k]}:</strong> ${esc(v)}`).join('<br>')}</p>`;
}

function diagnosticsPage(main) {
  main.innerHTML = `<div class="pagehead"><div><h1>Diagnostics</h1><p class="muted">If something isn't working, start here.</p></div><button id="again">Check again</button></div>
    <ul class="checks" id="checks"><li class="empty">Checking...</li></ul>`;
  const run = async () => renderChecks($('#checks'), await api('/api/diagnostics'));
  $('#again').onclick = e => busy(e.target, run);
  run();
}

boot();
