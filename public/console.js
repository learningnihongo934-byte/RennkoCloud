// Rennko Cloud console. It's an app on Rennko Cloud itself: developers are users of the "console" project.
import { initApp } from './rennko.js';

const me = initApp(location.origin);
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><path d="M16 6c1 5 7 7 7 13a7 7 0 0 1-14 0c0-3 2-5 3-6 0 3 1 4 2 4 0-4 0-8 2-11z" fill="var(--accent-ink)"/></svg>`;
const fmtBytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtTime = t => (t ? new Date(t).toLocaleString() : '—');

function toast(msg, bad) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

async function call(base, path, { method = 'GET', body, headers = {}, raw } = {}) {
  const h = { authorization: 'Bearer ' + (await me.auth.getToken()), ...headers };
  if (body !== undefined && !raw) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers: h, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || r.statusText);
  return data;
}
const platform = (path, o) => call('', '/v1' + path, o);

let state = { projects: null, project: null, info: null, papp: null, cleanup: [] };

// ---- routing ----
me.auth.onAuthChange(() => route());
addEventListener('hashchange', () => route());

async function route() {
  for (const f of state.cleanup) try { f(); } catch {}
  state.cleanup = [];
  await me.ready;
  if (!me.auth.currentUser) return renderAuth();
  if (location.hash.startsWith('#/admin')) return renderAdmin((location.hash.match(/^#\/admin\/(\w+)/) || [])[1] || 'domains');
  const [, id, tab = 'overview'] = (location.hash.match(/^#\/p\/([^/]+)(?:\/(\w+))?/) || []);
  if (!id) return renderProjects(new URLSearchParams(location.hash.split('?')[1] || '').get('name') || '');
  return renderProject(id, tab);
}

// ---- sign in ----
function renderAuth(mode = 'signin') {
  $app.innerHTML = `
  <div class="auth"><div class="auth-card">
    <div class="logo">${LOGO} Rennko Cloud</div>
    <p class="pitch">The free backend for your apps. Auth, a realtime database, file storage and hosting at <b>your-app.rennko.tech</b>. Works offline.</p>
    <form id="f">
      <h2>${mode === 'signin' ? 'Sign in' : 'Create your free account'}</h2>
      <label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
      <label for="pw">Password</label><input id="pw" type="password" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}" minlength="6" required>
      <button class="primary" type="submit">${mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      <div class="err" id="e"></div>
    </form>
    <div class="switch">${mode === 'signin' ? 'New here?' : 'Have an account?'} <button id="sw" type="button">${mode === 'signin' ? 'Create an account' : 'Sign in'}</button></div>
    <div class="features"><span>Email, Google &amp; anonymous auth</span><span>Live database queries</span><span>Offline sync built in</span><span>File storage</span><span>Static hosting</span><span>Free and open source</span></div>
  </div></div>`;
  document.getElementById('sw').onclick = () => renderAuth(mode === 'signin' ? 'signup' : 'signin');
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const email = document.getElementById('email').value, pw = document.getElementById('pw').value;
      if (mode === 'signin') await me.auth.signIn(email, pw); else await me.auth.signUp(email, pw);
    } catch (x) { document.getElementById('e').textContent = x.message; btn.disabled = false; }
  };
}

function shell(crumbs, body) {
  $app.innerHTML = `
  <header class="top">
    <div class="crumbs"><a class="logo" href="#/">${LOGO}<span>Rennko Cloud</span></a>${crumbs}</div>
    <span class="who">${esc(me.auth.currentUser.email)}</span>
    ${me.auth.currentUser.platformAdmin ? '<a class="btn" href="#/admin">Admin</a>' : ''}
    <button class="ghost" id="out">Sign out</button>
  </header>
  <main class="wrap">${body}</main>
  <footer>Rennko Cloud is free and open source · Made by <b>Virat Reddy Kaukuntla</b></footer>`;
  document.getElementById('out').onclick = () => { location.hash = '#/'; me.auth.signOut(); };
}

// ---- projects ----
async function renderProjects(prefill = '') {
  shell('', `<div class="page-head"><h1>Your projects</h1></div><div class="grid" id="list"><div class="dim">Loading…</div></div>`);
  let projects;
  try { projects = (await platform('/projects')).projects; } catch (e) { return toast(e.message, true); }
  document.getElementById('list').innerHTML = projects.map(p => `
    <a class="card" href="#/p/${esc(p.id)}"><h2>${esc(p.id)}</h2><div class="url">${esc(p.url)}</div></a>`).join('') + `
    <div class="card new-card"><h2>New project</h2>
      <div class="dim small">Pick a name for <b>name.rennko.tech</b></div>
      <form id="nf"><input id="nid" placeholder="my-app" pattern="[a-z][a-z0-9\\-]{1,28}[a-z0-9]" required aria-label="Project name"><button class="primary">Create</button></form>
      <div class="err" id="ne"></div></div>`;
  const nid = document.getElementById('nid');
  if (prefill || location.hash.startsWith('#/new')) { nid.value = prefill.toLowerCase().replace(/[^a-z0-9-]/g, '-'); nid.focus(); }
  nid.oninput = () => { nid.value = nid.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'); };
  document.getElementById('nf').onsubmit = async e => {
    e.preventDefault();
    try {
      const p = await platform('/projects', { method: 'POST', body: { id: nid.value } });
      location.hash = `#/p/${p.id}`;
    } catch (x) { document.getElementById('ne').textContent = x.message; }
  };
}

// ---- a project ----
const TABS = [['overview', 'Overview'], ['database', 'Database'], ['auth', 'Authentication'], ['storage', 'Storage'], ['hosting', 'Hosting'], ['rules', 'Rules'], ['settings', 'Settings']];

async function renderProject(id, tab) {
  if (state.project?.id !== id) {
    state.papp?.close();
    const list = (await platform('/projects').catch(() => ({ projects: [] }))).projects;
    let p = list.find(x => x.id === id);
    // Rennko Cloud admins can open anyone's project
    if (!p && me.auth.currentUser.platformAdmin) p = (await platform('/admin/overview').catch(() => ({ projects: [] }))).projects.find(x => x.id === id);
    if (!p) { toast(`No project "${id}"`, true); location.hash = '#/'; return; }
    state.project = p;
    state.papp = initApp({ url: p.url, token: () => me.auth.getToken(), persistence: false });
  }
  const p = state.project;
  shell(`<span class="dim">/</span><a href="#/p/${esc(id)}">${esc(id)}</a>`, `
    <div class="page-head"><div><h1>${esc(id)}</h1><a class="small" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)} ↗</a></div></div>
    <nav class="tabs">${TABS.map(([k, n]) => `<a href="#/p/${esc(id)}/${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('')}</nav>
    <section id="tab"><div class="dim">Loading…</div></section>`);
  const $tab = document.getElementById('tab');
  const admin = (path, o) => call(p.url, '/__/' + path, o);
  try {
    state.info = await admin('admin/info');
    if (state.info.suspended) $tab.insertAdjacentHTML('beforebegin', `<div class="card" style="border-color:var(--bad);margin-bottom:1rem"><b style="color:var(--bad)">This project is suspended.</b> <span class="dim">Its site and API are offline${state.info.suspended.reason ? ` (${esc(state.info.suspended.reason)})` : ''}. ${me.auth.currentUser.platformAdmin ? 'Unsuspend it in Settings.' : 'Contact Rennko Cloud if you think this is a mistake.'}</span></div>`);
    await ({ overview, database, auth, storage, hosting, rules, settings })[tab]?.($tab, p, admin, state.info);
  } catch (e) { $tab.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function overview($t, p, admin, info) {
  const u = info.usage;
  const pct = Math.min(100, (u.bytes / u.cap) * 100);
  $t.innerHTML = `
  <div class="tiles">
    <div class="tile"><div class="n">${fmtBytes(u.bytes)}</div><div class="l">of ${fmtBytes(u.cap)} used</div><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></div>
    <div class="tile"><div class="n">${u.users}</div><div class="l">Users</div></div>
    <div class="tile"><div class="n">${u.docs}</div><div class="l">Documents</div></div>
    <div class="tile"><div class="n">${u.files}</div><div class="l">Files</div></div>
    <div class="tile"><div class="n">${u.connections}</div><div class="l">Live connections</div></div>
  </div>
  <div class="stack">
    <div class="card"><h2>Add Rennko Cloud to your app</h2>
      <p class="dim small">Import the SDK straight from your project. No install or build step needed. Data is cached on the device, so your app keeps working offline and syncs when it's back online.</p>
      <pre class="snippet"><code>${esc(`<script type="module">
  import { app, serverTimestamp } from '${p.url}/__/init.js';

  await app.auth.signInAnonymously();
  const chat = app.db.collection('messages');

  // Live query: runs now from the offline cache, then on every change
  chat.orderBy('at').limit(50).onSnapshot(snap => {
    console.log(snap.docs.map(d => d.data()));
  });

  chat.add({ text: 'Hello!', uid: app.auth.currentUser.uid, at: serverTimestamp() });
</script>`)}</code></pre>
      <p class="small dim">Using npm or a bundler? <code>import { initApp } from '${esc(location.origin)}/rennko.js'</code> then <code>initApp('${esc(p.url)}')</code>.</p>
    </div>
    <div class="card"><h2>Admin key</h2>
      <p class="dim small">Full access that skips your rules, for servers and scripts (send it as the <code>x-admin-key</code> header). Keep it secret.</p>
      <div class="row"><input id="key" type="password" readonly value="${esc(info.adminKey)}" aria-label="Admin key"><button id="show">Show</button><button id="rot" class="danger">Rotate</button></div>
    </div>
  </div>`;
  document.getElementById('show').onclick = e => { const k = document.getElementById('key'); k.type = k.type === 'password' ? 'text' : 'password'; e.target.textContent = k.type === 'password' ? 'Show' : 'Hide'; };
  document.getElementById('rot').onclick = async () => {
    if (!confirm('Make a new admin key? The old one stops working right away.')) return;
    document.getElementById('key').value = (await admin('admin/rotate-key', { method: 'POST', body: {} })).adminKey;
    toast('New admin key made');
  };
}

// ---- database ----
async function database($t, p, admin) {
  $t.innerHTML = `
  <div class="db">
    <div><div class="head">Collections <button class="ghost small" id="addc" title="Open a collection">＋</button></div><div class="list" id="cols"></div></div>
    <div><div class="head"><span id="ctitle">Documents</span> <span class="row"><span class="badge live" id="live" hidden>LIVE</span><button class="ghost small" id="addd" title="Add document" disabled>＋</button></span></div><div class="list" id="docs"><div class="empty">Pick a collection.</div></div></div>
    <div><div class="head" id="dtitle">Document</div><div class="editor" id="ed"><div class="empty">Pick or add a document.</div></div></div>
  </div>`;
  const db = state.papp.db;
  let col = null, unsub = null, docPath = null;
  state.cleanup.push(() => unsub?.());

  const loadCols = async () => {
    const { collections } = await admin('admin/collections');
    if (col && !collections.some(c => c.name === col)) collections.push({ name: col, count: 0 });
    document.getElementById('cols').innerHTML = collections.length ? collections.map(c => `<button class="item ${c.name === col ? 'on' : ''}" data-c="${esc(c.name)}">${esc(c.name)}<span class="c">${c.count}</span></button>`).join('') : '<div class="empty">No data yet. Click ＋ to start a collection.</div>';
  };
  const openCol = name => {
    col = name; docPath = null;
    unsub?.();
    document.getElementById('ctitle').textContent = name;
    document.getElementById('addd').disabled = false;
    document.getElementById('live').hidden = false;
    showDoc(null);
    unsub = db.collection(name).limit(500).onSnapshot(snap => {
      document.getElementById('docs').innerHTML = snap.empty ? '<div class="empty">No documents.</div>' : snap.docs.map(d => `<button class="item ${d.path === docPath ? 'on' : ''}" data-d="${esc(d.path)}">${esc(d.id)}</button>`).join('');
      if (docPath) { const d = snap.docs.find(x => x.path === docPath); if (d && !document.getElementById('json')?.matches(':focus')) showDoc(d.path, d.data()); }
      loadCols().catch(() => {});
    }, e => toast(e.message, true));
    loadCols().catch(() => {});
  };
  const showDoc = (path, data, isNew) => {
    docPath = path;
    const ed = document.getElementById('ed');
    document.getElementById('dtitle').textContent = isNew ? 'New document' : path || 'Document';
    if (!path && !isNew) { ed.innerHTML = '<div class="empty">Pick or add a document.</div>'; return; }
    ed.innerHTML = `${isNew ? '<input id="nid" placeholder="Document ID (blank = random)" aria-label="Document ID">' : ''}
      <textarea class="code" id="json" spellcheck="false" aria-label="Document JSON">${esc(JSON.stringify(data ?? {}, null, 2))}</textarea>
      <div class="row"><button class="primary" id="save">Save</button>${isNew ? '' : '<button class="danger" id="del">Delete</button>'}<span class="err" id="je"></span></div>`;
    document.getElementById('save').onclick = async () => {
      let obj;
      try { obj = JSON.parse(document.getElementById('json').value); } catch (e) { document.getElementById('je').textContent = 'Not valid JSON: ' + e.message; return; }
      const ref = isNew ? (document.getElementById('nid').value.trim() ? db.collection(col).doc(document.getElementById('nid').value.trim()) : db.collection(col).doc()) : db.doc(path);
      try { await ref.set(obj); toast('Saved'); docPath = ref.path; showDoc(ref.path, obj); } catch (e) { document.getElementById('je').textContent = e.message; }
    };
    if (!isNew) document.getElementById('del').onclick = async () => {
      if (!confirm(`Delete ${path}?`)) return;
      try { await db.doc(path).delete(); showDoc(null); toast('Deleted'); } catch (e) { toast(e.message, true); }
    };
  };
  document.getElementById('cols').onclick = e => { const b = e.target.closest('[data-c]'); if (b) openCol(b.dataset.c); };
  document.getElementById('docs').onclick = async e => {
    const b = e.target.closest('[data-d]');
    if (!b) return;
    document.querySelectorAll('#docs .item').forEach(x => x.classList.toggle('on', x === b));
    const snap = await db.doc(b.dataset.d).get();
    showDoc(b.dataset.d, snap.data());
  };
  document.getElementById('addc').onclick = () => {
    const name = prompt('Collection path (for example "posts", or "users/abc/notes")');
    if (name) try { db.collection(name.trim()); openCol(name.trim()); } catch (e) { toast(e.message, true); }
  };
  document.getElementById('addd').onclick = () => showDoc(null, {}, true);
  await loadCols();
  const iv = setInterval(() => loadCols().catch(() => {}), 4000);
  state.cleanup.push(() => clearInterval(iv));
}

// ---- auth ----
async function auth($t, p, admin, info) {
  $t.innerHTML = `
  <div class="stack">
    <div class="page-head" style="margin:0"><h2>Users</h2><input id="q" placeholder="Search by email or uid" style="max-width:320px" aria-label="Search users"></div>
    <div class="table-wrap" id="users"><div class="dim">Loading…</div></div>
    <div class="card"><h2>Sign-in methods</h2>
      <p class="small dim">Email/password and anonymous sign-in always work. For GitHub or Google, register an OAuth app and paste its client ID and secret here. Your app then calls <code>app.auth.signInWithGitHub()</code> or <code>signInWithGoogle()</code>.</p>
      ${['github', 'google'].map(prov => {
        const o = info.settings.oauth?.[prov] || {};
        const name = prov === 'github' ? 'GitHub' : 'Google';
        const help = prov === 'github'
          ? 'Make one at <a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a> → New OAuth App.'
          : 'Make one in the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud console</a> → Create credentials → OAuth client ID → Web application.';
        return `<h3 style="margin-top:1.2rem">${name} ${o.secretSet ? '<span class="badge live">ON</span>' : '<span class="badge">OFF</span>'}</h3>
          <p class="small dim">${help} Use this as the callback / redirect URL:</p>
          <div class="row"><input readonly value="${esc(p.url)}/__/auth/oauth/${prov}/callback" aria-label="${name} callback URL"><button data-copy="${esc(p.url)}/__/auth/oauth/${prov}/callback">Copy</button></div>
          <div class="row" style="margin-top:.5rem"><input id="${prov}-id" placeholder="Client ID" value="${esc(o.clientId || '')}" aria-label="${name} client ID"><input id="${prov}-secret" type="password" placeholder="${o.secretSet ? 'Client secret (saved, leave blank to keep)' : 'Client secret'}" aria-label="${name} client secret"></div>`;
      }).join('')}
      <h3 style="margin-top:1.2rem">Authorized domains</h3>
      <p class="small dim">Sites allowed to open the sign-in pop-up, one per line. ${esc(p.url)} and localhost are always allowed.</p>
      <textarea id="origins" rows="3" placeholder="https://myapp.com" aria-label="Authorized domains">${esc((info.settings.authorizedOrigins || []).join('\n'))}</textarea>
      <div class="row" style="margin-top:.8rem"><button id="gsave" class="primary">Save sign-in settings</button></div>
    </div>
  </div>`;
  const load = async () => {
    const { users, total } = await admin('admin/users?q=' + encodeURIComponent(document.getElementById('q').value));
    document.getElementById('users').innerHTML = users.length ? `<table><thead><tr><th>User</th><th>Provider</th><th>Created</th><th>Last sign-in</th><th>UID</th><th></th></tr></thead><tbody>${users.map(u => `
      <tr><td>${u.email ? esc(u.email) : '<span class="dim">Anonymous</span>'}</td><td>${esc(u.provider)}</td><td>${fmtTime(u.created)}</td><td>${fmtTime(u.last)}</td><td class="mono">${esc(u.uid)}</td><td class="row" style="flex-wrap:nowrap">${u.disabled ? '<span class="badge" style="color:var(--bad)">BANNED</span>' : ''}<button class="ghost small" data-ban="${esc(u.uid)}" data-on="${u.disabled ? '' : '1'}">${u.disabled ? 'Unban' : 'Ban'}</button><button class="ghost danger small" data-del="${esc(u.uid)}">Delete</button></td></tr>`).join('')}</tbody></table><p class="small dim">${total} users in total</p>` : '<div class="card dim">No users yet.</div>';
  };
  document.getElementById('users').onclick = async e => {
    if (e.target.dataset.ban) {
      const on = !!e.target.dataset.on;
      if (on && !confirm('Ban this user? They are signed out right away and can\'t sign back in.')) return;
      await admin('admin/users/' + e.target.dataset.ban, { method: 'PUT', body: { disabled: on } });
      toast(on ? 'User banned' : 'User unbanned');
      return load();
    }
    const uid = e.target.dataset.del;
    if (!uid || !confirm('Delete this user? They are signed out everywhere. Their data stays.')) return;
    await admin('admin/users/' + uid, { method: 'DELETE' });
    toast('User deleted');
    load();
  };
  let t;
  document.getElementById('q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  $t.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); });
  document.getElementById('gsave').onclick = async () => {
    const oauth = {};
    for (const prov of ['github', 'google']) oauth[prov] = { clientId: document.getElementById(prov + '-id').value.trim(), clientSecret: document.getElementById(prov + '-secret').value.trim() };
    try {
      info.settings = await admin('admin/settings', { method: 'PUT', body: { oauth, authorizedOrigins: document.getElementById('origins').value.split(/\s+/).filter(Boolean) } });
      toast('Sign-in settings saved');
      auth($t, p, admin, info);
    } catch (e) { toast(e.message, true); }
  };
  await load();
}

// ---- storage ----
async function storage($t, p, admin) {
  $t.innerHTML = `
  <div class="stack">
    <div class="drop" id="drop">Drop files here, or <label class="btn" style="display:inline-flex;margin:0 .3rem">choose files<input type="file" id="pick" multiple hidden></label> to upload into
      <input id="prefix" placeholder="folder/ (optional)" style="max-width:220px;display:inline-block;margin-left:.3rem" aria-label="Upload folder"></div>
    <div class="table-wrap" id="files"><div class="dim">Loading…</div></div>
  </div>`;
  const st = state.papp.storage;
  const load = async () => {
    const files = await st.list('');
    document.getElementById('files').innerHTML = files.length ? `<table><thead><tr><th>Path</th><th>Size</th><th>Type</th><th>Updated</th><th></th></tr></thead><tbody>${files.map(f => `
      <tr><td><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.path)}</a></td><td>${fmtBytes(f.size)}</td><td class="mono">${esc(f.type)}</td><td>${fmtTime(f.updated)}</td>
      <td class="row" style="flex-wrap:nowrap"><button class="ghost small" data-copy="${esc(f.url)}">Copy link</button><button class="ghost danger small" data-del="${esc(f.path)}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<div class="card dim">No files yet.</div>';
  };
  const upload = async files => {
    const prefix = document.getElementById('prefix').value.trim().replace(/^\/+/, '').replace(/([^/])$/, '$1/');
    for (const f of files) {
      try { await st.upload(prefix + f.name, f); toast(`Uploaded ${f.name}`); } catch (e) { toast(`${f.name}: ${e.message}`, true); }
    }
    load();
  };
  document.getElementById('pick').onchange = e => upload([...e.target.files]);
  dropZone(document.getElementById('drop'), async items => upload(items.map(i => i.file)));
  document.getElementById('files').onclick = async e => {
    if (e.target.dataset.copy) { await navigator.clipboard.writeText(e.target.dataset.copy); toast('Link copied'); }
    if (e.target.dataset.del && confirm(`Delete ${e.target.dataset.del}?`)) { await st.delete(e.target.dataset.del); toast('Deleted'); load(); }
  };
  await load();
}

// ---- hosting ----
async function hosting($t, p, admin, info) {
  const h = info.hosting;
  $t.innerHTML = `
  <div class="stack">
    <div class="card"><h2>Live site</h2>
      ${h ? `<p>Version ${h.version} · ${h.files} files · ${fmtBytes(h.size)} · deployed ${fmtTime(h.at)}</p>` : '<p class="dim">Nothing deployed yet.</p>'}
      <a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">Open ${esc(p.url.replace(/^https?:\/\//, ''))} ↗</a>
    </div>
    <div class="card"><h2>Deploy</h2>
      <p class="small dim">Drop your site's folder (the one with <code>index.html</code>). Only changed files are uploaded.</p>
      <div class="drop" id="drop">Drop a folder here, or <label class="btn" style="display:inline-flex;margin:0 .3rem">choose a folder<input type="file" id="pick" webkitdirectory multiple hidden></label></div>
      <label class="check"><input type="checkbox" id="spa" ${h?.config?.spa ? 'checked' : ''}> Single-page app (unknown paths serve <code>index.html</code>)</label>
      <label class="check"><input type="checkbox" id="clean" ${h?.config?.cleanUrls ? 'checked' : ''}> Clean URLs (<code>/about</code> serves <code>about.html</code>)</label>
      <label class="check"><input type="checkbox" id="disc" ${info.settings.discover === false ? '' : 'checked'}> Show in Discover (ranked by today's visits, using your page's title, description and <code>og:image</code>)</label>
      <div class="log" id="log" hidden></div>
    </div>
    <div class="card"><h2>Deploy from the terminal</h2>
      <pre class="snippet"><code>npx github:learningnihongo934-byte/RennkoCloud login
npx github:learningnihongo934-byte/RennkoCloud deploy --project ${esc(p.id)} --dir ./public</code></pre>
    </div>
  </div>`;
  const log = m => { const l = document.getElementById('log'); l.hidden = false; l.textContent += m + '\n'; l.scrollTop = l.scrollHeight; };
  const deploy = async items => {
    document.getElementById('log').textContent = '';
    // Strip the folder's own name so its index.html lands at /
    const rel = items.map(i => i.path.replace(/^\/+/, ''));
    const top = rel.every(r => r.includes('/')) && new Set(rel.map(r => r.split('/')[0])).size === 1 ? rel[0].split('/')[0].length + 1 : 0;
    const files = items.map((i, n) => ({ path: '/' + rel[n].slice(top), file: i.file })).filter(f => !/(^|\/)\.[^/]/.test(f.path));
    if (!files.some(f => f.path === '/index.html')) log('Heads up: there is no index.html at the top level.');
    log(`Hashing ${files.length} files…`);
    const manifest = {};
    for (const f of files) {
      f.buf = await f.file.arrayBuffer();
      f.hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', f.buf))].map(b => b.toString(16).padStart(2, '0')).join('');
      manifest[f.path] = { hash: f.hash, size: f.buf.byteLength, type: f.file.type || undefined };
    }
    try {
      const { missing } = await admin('hosting/plan', { method: 'POST', body: { files: manifest } });
      log(`Uploading ${missing.length} new or changed files…`);
      const todo = files.filter((f, i, a) => missing.includes(f.hash) && a.findIndex(x => x.hash === f.hash) === i);
      let done = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (todo.length) {
          const f = todo.shift();
          await admin('hosting/blob/' + f.hash, { method: 'PUT', body: f.buf, raw: true, headers: { 'content-type': 'application/octet-stream' } });
          log(`  ${++done}/${missing.length} ${f.path}`);
        }
      }));
      const rel2 = await admin('hosting/release', { method: 'POST', body: { files: manifest, config: { spa: document.getElementById('spa').checked, cleanUrls: document.getElementById('clean').checked } } });
      log(`Live! Version ${rel2.version} at ${p.url}`);
      toast('Deployed');
      state.info = await admin('admin/info');
    } catch (e) { log('Failed: ' + e.message); toast(e.message, true); }
  };
  document.getElementById('pick').onchange = e => deploy([...e.target.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f })));
  dropZone(document.getElementById('drop'), deploy);
  document.getElementById('disc').onchange = async e => {
    await admin('admin/settings', { method: 'PUT', body: { discover: e.target.checked } });
    toast(e.target.checked ? 'Your site shows in Discover' : 'Hidden from Discover');
  };
}

// Collects dropped files, walking into folders. Gives [{ path, file }].
function dropZone(el, onFiles) {
  el.ondragover = e => { e.preventDefault(); el.classList.add('over'); };
  el.ondragleave = () => el.classList.remove('over');
  el.ondrop = async e => {
    e.preventDefault();
    el.classList.remove('over');
    const out = [];
    const walk = async (entry, path) => {
      if (entry.isFile) out.push({ path: path + entry.name, file: await new Promise((res, rej) => entry.file(res, rej)) });
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const c of batch) await walk(c, path + entry.name + '/');
        } while (batch.length);
      }
    };
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const en of entries) await walk(en, '');
    else for (const f of e.dataTransfer.files) out.push({ path: f.name, file: f });
    if (out.length) onFiles(out);
  };
}

// ---- rules ----
const RULE_EXAMPLES = {
  'Signed-in users only (default)': { db: { '**': { read: 'auth != null', write: 'auth != null' } }, storage: { '**': { read: 'auth != null', write: 'auth != null' } } },
  'Each user owns their docs': { db: { 'users/{uid}/**': { read: 'auth.uid == uid', write: 'auth.uid == uid' }, 'posts/{id}': { read: 'true', create: 'data.owner == auth.uid', update: 'doc.owner == auth.uid && data.owner == auth.uid', delete: 'doc.owner == auth.uid' } }, storage: { 'avatars/{uid}/**': { read: 'true', write: 'auth.uid == uid && data.size < 5000000', delete: 'auth.uid == uid' } } },
  'Public read, signed-in write': { db: { '**': { read: 'true', write: 'auth != null' } }, storage: { '**': { read: 'true', write: 'auth != null' } } },
  'Open (testing only!)': { db: { '**': { read: 'true', write: 'true' } }, storage: { '**': { read: 'true', write: 'true' } } },
};
function rules($t, p, admin, info) {
  $t.innerHTML = `
  <div class="stack">
    <div class="card"><h2>Security rules</h2>
      <p class="small dim">Rules decide who can read and write. Each path pattern maps actions (<code>read</code>, <code>write</code>, or the finer <code>get list create update delete</code>) to a condition.
      <code>{name}</code> matches one path segment and <code>**</code> matches the rest. Conditions can use <code>auth</code> (the user, or <code>null</code>),
      <code>doc</code> (the stored data), <code>data</code> (the incoming data; for files, <code>data.size</code> and <code>data.type</code>), <code>now</code>, and your <code>{name}</code> variables.
      Requests are allowed if any matching rule says yes. The admin key and this console skip the rules.</p>
      <textarea class="code" id="rules" rows="18" spellcheck="false" style="margin-top:.6rem" aria-label="Rules JSON">${esc(JSON.stringify(info.rules, null, 2))}</textarea>
      <div class="row" style="margin-top:.6rem"><button class="primary" id="save">Publish rules</button><select id="ex" style="max-width:300px" aria-label="Load an example"><option value="">Load an example…</option>${Object.keys(RULE_EXAMPLES).map(k => `<option>${esc(k)}</option>`).join('')}</select><span class="err" id="re"></span></div>
    </div>
  </div>`;
  document.getElementById('ex').onchange = e => { if (e.target.value) document.getElementById('rules').value = JSON.stringify(RULE_EXAMPLES[e.target.value], null, 2); };
  document.getElementById('save').onclick = async () => {
    document.getElementById('re').textContent = '';
    let r;
    try { r = JSON.parse(document.getElementById('rules').value); } catch (e) { document.getElementById('re').textContent = 'Not valid JSON: ' + e.message; return; }
    try { await admin('admin/rules', { method: 'PUT', body: r }); toast('Rules published'); } catch (e) { document.getElementById('re').textContent = e.message; }
  };
}

// ---- settings ----
function settings($t, p, admin, info) {
  $t.innerHTML = `
  <div class="stack">
    <div class="card"><h2>Project</h2><p>ID <code>${esc(p.id)}</code> · created ${fmtTime(info.created)}</p></div>
    ${me.auth.currentUser.platformAdmin ? `<div class="card"><h2>Rennko Cloud admin</h2>
      <p class="small dim">${info.suspended ? `Suspended ${fmtTime(info.suspended.at)}${info.suspended.reason ? ` · ${esc(info.suspended.reason)}` : ''}` : 'This project is live.'}</p>
      <div class="row">${info.suspended ? '<button class="primary" id="unsus">Unsuspend</button>' : '<input id="reason" placeholder="Reason (shown to the owner)" aria-label="Suspension reason"><button class="danger" id="sus">Suspend</button>'}</div></div>` : ''}
    <div class="card"><h2>Delete project</h2>
      <p class="small dim">Deletes all of this project's data, users, files and its site. This can't be undone. Type <b>${esc(p.id)}</b> to confirm.</p>
      <div class="row"><input id="conf" aria-label="Type the project name"><button class="danger" id="del">Delete forever</button></div>
    </div>
  </div>`;
  const sus = async (action, reason) => { await platform(`/admin/projects/${p.id}/${action}`, { method: 'POST', body: { reason } }); toast(action === 'suspend' ? 'Project suspended' : 'Project is live again'); route(); };
  document.getElementById('sus')?.addEventListener('click', () => sus('suspend', document.getElementById('reason').value));
  document.getElementById('unsus')?.addEventListener('click', () => sus('unsuspend'));
  document.getElementById('del').onclick = async () => {
    if (document.getElementById('conf').value !== p.id) return toast(`Type ${p.id} to confirm`, true);
    try {
      await platform((me.auth.currentUser.platformAdmin ? '/admin/projects/' : '/projects/') + p.id, { method: 'DELETE' });
      state.papp?.close(); state.project = null; state.papp = null;
      toast('Project deleted');
      location.hash = '#/';
    } catch (e) { toast(e.message, true); }
  };
}

// ---- Rennko Cloud admin ----
async function renderAdmin(tab) {
  if (!me.auth.currentUser.platformAdmin) { location.hash = '#/'; return; }
  shell('<span class="dim">/</span><a href="#/admin">Admin</a>', `<div class="page-head"><h1>Rennko Cloud admin</h1><button id="refresh">Refresh</button></div><div id="adm"><div class="dim">Loading…</div></div>`);
  document.getElementById('refresh').onclick = () => route();
  let o;
  try { o = await platform('/admin/overview'); } catch (e) { document.getElementById('adm').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const t = o.totals;
  const tabs = [['domains', `Domains (${t.projects})`], ['developers', `Developers (${t.developers})`], ['blocked', `Blocked names (${o.blockedNames.length})`]];
  document.getElementById('adm').innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="n">${t.projects}</div><div class="l">Domains</div></div>
      <div class="tile"><div class="n">${t.developers}</div><div class="l">Developers</div></div>
      <div class="tile"><div class="n">${t.appUsers}</div><div class="l">App users</div></div>
      <div class="tile"><div class="n">${fmtBytes(t.bytes)}</div><div class="l">of 5 GB free plan</div><div class="bar"><i style="width:${Math.min(100, t.bytes / 5368709120 * 100).toFixed(1)}%"></i></div></div>
      <div class="tile"><div class="n">${t.docs}</div><div class="l">Documents</div></div>
      <div class="tile"><div class="n">${t.connections}</div><div class="l">Live connections</div></div>
      <div class="tile"><div class="n">${t.visitsToday}</div><div class="l">Site visits today</div></div>
    </div>
    <nav class="tabs">${tabs.map(([k, n]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('')}</nav>
    <section id="atab"></section>`;
  const $a = document.getElementById('atab');
  const act = async (fn, msg) => { try { await fn(); toast(msg); route(); } catch (e) { toast(e.message, true); } };

  if (tab === 'domains') {
    $a.innerHTML = `<input id="q" placeholder="Search domains or owners" style="max-width:340px;margin-bottom:.8rem" aria-label="Search domains">
      <div class="table-wrap"><table><thead><tr><th>Domain</th><th>Owner</th><th>Created</th><th>Storage</th><th>Users</th><th>Docs</th><th>Visits today</th><th>Site</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>`;
    const draw = () => {
      const q = document.getElementById('q').value.toLowerCase();
      const rows = o.projects.filter(p => !q || p.id.includes(q) || (p.ownerEmail || '').toLowerCase().includes(q)).sort((a, b) => b.visitsToday - a.visitsToday || b.created - a.created);
      document.getElementById('rows').innerHTML = rows.map(p => `<tr>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener"><b>${esc(p.id)}</b></a><div class="small dim">${esc(p.url.replace(/^https?:\/\//, ''))}</div></td>
        <td>${esc(p.ownerEmail || '—')}${p.ownerDisabled ? ' <span class="badge" style="color:var(--bad)">BANNED</span>' : ''}</td>
        <td>${fmtTime(p.created)}</td><td>${p.usage ? fmtBytes(p.usage.bytes) : '—'}</td><td>${p.usage?.users ?? '—'}</td><td>${p.usage?.docs ?? '—'}</td><td>${p.visitsToday}</td>
        <td>${p.site ? `v${p.site.version} · ${p.site.files} files` : '<span class="dim">none</span>'}</td>
        <td>${p.suspended ? '<span class="badge" style="color:var(--bad)">SUSPENDED</span>' : '<span class="badge live">LIVE</span>'}</td>
        <td class="row" style="flex-wrap:nowrap"><a class="btn" href="#/p/${esc(p.id)}">Manage</a>
          ${p.suspended ? `<button data-unsus="${esc(p.id)}">Unsuspend</button>` : `<button class="danger" data-sus="${esc(p.id)}">Suspend</button>`}
          <button class="ghost danger" data-del="${esc(p.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="10" class="dim">No domains yet.</td></tr>';
    };
    document.getElementById('q').oninput = draw;
    draw();
    $a.onclick = e => {
      const d = e.target.dataset;
      if (d.sus) { const reason = prompt(`Suspend ${d.sus}? Its site and API go offline. Reason (shown to the owner):`, ''); if (reason !== null) act(() => platform(`/admin/projects/${d.sus}/suspend`, { method: 'POST', body: { reason } }), `${d.sus} suspended`); }
      if (d.unsus) act(() => platform(`/admin/projects/${d.unsus}/unsuspend`, { method: 'POST', body: {} }), `${d.unsus} is live again`);
      if (d.del && prompt(`This deletes ${d.del} and all its data forever. Type ${d.del} to confirm.`) === d.del) act(() => platform(`/admin/projects/${d.del}`, { method: 'DELETE' }), `${d.del} deleted`);
    };
  }

  if (tab === 'developers') {
    $a.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Joined</th><th>Last sign-in</th><th>Projects</th><th>Status</th><th></th></tr></thead><tbody>${o.users.map(u => `<tr>
      <td>${esc(u.email || '—')}${u.admin ? ' <span class="badge live">ADMIN</span>' : ''}<div class="small dim mono">${esc(u.uid)}</div></td>
      <td>${fmtTime(u.created)}</td><td>${fmtTime(u.last)}</td><td>${u.projects}</td>
      <td>${u.disabled ? '<span class="badge" style="color:var(--bad)">BANNED</span>' : '<span class="badge">OK</span>'}</td>
      <td class="row" style="flex-wrap:nowrap">${u.admin ? '' : u.disabled ? `<button data-unban="${esc(u.uid)}">Unban</button>` : `<button class="danger" data-ban="${esc(u.uid)}" data-n="${u.projects}">Ban</button>`}
        ${u.admin ? '' : `<button class="ghost danger" data-del="${esc(u.uid)}" data-email="${esc(u.email)}" data-n="${u.projects}">Delete</button>`}</td></tr>`).join('')}</tbody></table></div>`;
    $a.onclick = e => {
      const d = e.target.dataset;
      if (d.ban && confirm('Ban this developer? They are signed out and can\'t sign in or make projects.')) {
        const suspendProjects = Number(d.n) > 0 && confirm(`Also suspend their ${d.n} project(s)?`);
        act(() => platform(`/admin/users/${d.ban}/ban`, { method: 'POST', body: { disabled: true, suspendProjects } }), 'Developer banned');
      }
      if (d.unban) act(() => platform(`/admin/users/${d.unban}/ban`, { method: 'POST', body: { disabled: false } }), 'Developer unbanned');
      if (d.del && prompt(`Delete ${d.email} and their ${d.n} project(s) forever? Type DELETE to confirm.`) === 'DELETE') act(() => platform(`/admin/users/${d.del}`, { method: 'DELETE' }), 'Developer deleted');
    };
  }

  if (tab === 'blocked') {
    $a.innerHTML = `<div class="card"><h2>Blocked names</h2>
      <p class="small dim">Nobody can create a project with these names, one per line. Built-in reserved names like www, console and cloud are always blocked.</p>
      <textarea id="bn" rows="10" class="code" aria-label="Blocked names">${esc(o.blockedNames.join('\n'))}</textarea>
      <div class="row" style="margin-top:.6rem"><button class="primary" id="bsave">Save</button></div></div>`;
    document.getElementById('bsave').onclick = () => act(() => platform('/admin/blocked-names', { method: 'PUT', body: { names: document.getElementById('bn').value.split(/\s+/).filter(Boolean) } }), 'Blocked names saved');
  }
}
