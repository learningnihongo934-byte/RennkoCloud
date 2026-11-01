// Rennko Cloud JavaScript SDK (browser and Node 22+).
// Offline-first: reads come from a local cache (IndexedDB in browsers), writes show up instantly
// and wait in a durable queue, and everything syncs over one WebSocket whenever there's a connection.
//
//   import { initApp, serverTimestamp } from 'https://console.rennko.tech/rennko.js';
//   const app = initApp('https://myapp.rennko.tech');
//   await app.auth.signInAnonymously();
//   app.db.collection('todos').where('done', '==', false).onSnapshot(snap => render(snap.docs));
//   app.db.collection('todos').add({ text: 'hi', done: false, at: serverTimestamp() });
import { applyOp, parseDocPath, checkColPath, normQuery, queryKey, runQuery, matches, newId, err } from './rennko-core.js';

export { newId };
export const serverTimestamp = () => ({ '.sv': 'timestamp' });
export const increment = n => ({ '.sv': { increment: n } });
export const deleteField = () => ({ '.sv': 'delete' });
export const arrayUnion = (...v) => ({ '.sv': { arrayUnion: v } });
export const arrayRemove = (...v) => ({ '.sv': { arrayRemove: v } });

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const colOf = p => p.slice(0, p.lastIndexOf('/'));
const idOf = p => p.slice(p.lastIndexOf('/') + 1);
const unref = t => (t && t.unref && t.unref(), t);
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

// ---- local persistence ----
function idbStore(name) {
  let dbp;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', mode);
    const out = fn(t.objectStore('kv'));
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  }));
  return {
    load: () => tx('readonly', s => {
      const out = new Map();
      s.openCursor().onsuccess = e => { const c = e.target.result; if (c) { out.set(c.key, c.value); c.continue(); } };
      return out;
    }),
    save: changes => tx('readwrite', s => { for (const [k, v] of changes) v === undefined ? s.delete(k) : s.put(v, k); }),
    clear: () => tx('readwrite', s => s.clear()),
  };
}

// In-memory store; pass the same map to a new app to simulate a restart.
export function memoryStore(map = new Map()) {
  return {
    map,
    async load() { return new Map([...map].map(([k, v]) => [k, clone(v)])); },
    async save(changes) { for (const [k, v] of changes) v === undefined ? map.delete(k) : map.set(k, clone(v)); },
    async clear() { map.clear(); },
  };
}

const apps = new Map();
export function initApp(opts) {
  const o = typeof opts === 'string' ? { url: opts } : { ...opts };
  o.url = o.url.replace(/\/+$/, '');
  const shared = !o.token && !o.storage;
  if (shared && apps.has(o.url)) return apps.get(o.url);
  const app = new App(o);
  if (shared) apps.set(o.url, app);
  return app;
}

class App {
  constructor(o) {
    this.url = o.url;
    this.wsUrl = this.url.replace(/^http/, 'ws') + '/__/ws';
    this.fixedToken = o.token || null; // string or () => token, for admin tools
    this.store = o.storage || (o.persistence !== false && typeof indexedDB !== 'undefined' ? idbStore('rennko:' + this.url) : memoryStore());
    this.docs = new Map();    // path -> { data, updated }   last known server state
    this.queries = new Map(); // queryKey -> [paths]          last server result per query
    this.queue = [];          // pending write batches { id, at, ops }
    this.listeners = new Set();
    this.subs = new Map();
    this.inflight = new Set();
    this.waiters = new Map();
    this.pending = new Map();
    this.dirty = new Map();
    this.connCbs = new Set();
    this.errorCbs = new Set();
    this.drains = new Set();
    this.network = o.network !== false;
    this.online = false;
    this.backoff = 0;
    this.seq = 0;
    this.auth = new Auth(this);
    this.db = new Db(this);
    this.storage = new Storage(this);
    this.ready = this.load();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', () => { this.backoff = 0; this.connect(); });
    }
  }

  async load() {
    let m;
    try { m = await this.store.load(); } catch (e) { console.warn('[rennko] offline cache unavailable', e); m = new Map(); }
    for (const [k, v] of m) {
      if (k.startsWith('d:')) this.docs.set(k.slice(2), v);
      else if (k.startsWith('q:')) this.queries.set(k.slice(2), v);
    }
    this.queue = m.get('queue') || [];
    this.auth._load(m.get('auth') || null);
    this.notify();
    if (this.queue.length) this.connect();
  }

  persist(key, val) {
    this.dirty.set(key, val);
    if (!this.saveTimer) this.saveTimer = unref(setTimeout(() => this.flushSave(), 50));
  }
  async flushSave() {
    this.saveTimer = null;
    const ch = this.dirty;
    this.dirty = new Map();
    if (ch.size) try { await this.store.save(ch); } catch (e) { console.warn('[rennko] could not save offline data', e); }
  }
  setDoc(path, data, updated) {
    if (data == null) { this.docs.delete(path); this.persist('d:' + path, undefined); }
    else { const v = { data, updated }; this.docs.set(path, v); this.persist('d:' + path, v); }
  }
  async clearCache() {
    this.docs.clear(); this.queries.clear(); this.dirty.clear();
    for (const b of this.queue) this.waiters.get(b.id)?.reject(err('cancelled', 'Signed out before this write synced'));
    this.queue = []; this.waiters.clear(); this.inflight.clear();
    const authState = this.auth.s;
    try { await this.store.clear?.(); } catch {}
    if (authState) this.persist('auth', authState);
    this.notify();
  }

  // ---- local views (server state + pending writes) ----
  localDoc(path) {
    let data = this.docs.get(path)?.data ?? null, pending = false;
    for (const b of this.queue) for (const op of b.ops) {
      if (op.path !== path) continue;
      try { data = applyOp(op, data, b.at); } catch {}
      pending = true;
    }
    return { data, pending };
  }
  localQuery(q) {
    const base = this.queries.get(queryKey(q));
    const paths = new Set(base || [...this.docs.keys()].filter(p => colOf(p) === q.col));
    for (const b of this.queue) for (const op of b.ops) if (colOf(op.path) === q.col) paths.add(op.path);
    const docs = [];
    for (const p of paths) { const d = this.localDoc(p); if (d.data != null) docs.push({ path: p, id: idOf(p), data: d.data, pending: d.pending }); }
    const out = runQuery(base ? { ...q, offset: 0 } : q, docs);
    return { docs: out, pending: out.some(d => d.pending) };
  }

  // ---- listeners ----
  listen(l) {
    this.listeners.add(l);
    this.ready.then(() => { if (this.listeners.has(l)) { this.emit(l); this.subscribe(l); } });
    return () => {
      this.listeners.delete(l);
      for (const [sid, x] of this.subs) if (x === l) { this.subs.delete(sid); if (this.online) this.send({ t: 'unsub', id: sid }); }
    };
  }
  emit(l) {
    const v = l.doc ? this.localDoc(l.doc) : this.localQuery(l.q);
    const meta = { fromCache: !l.synced, hasPendingWrites: !!v.pending };
    const key = JSON.stringify([l.doc ? v.data : v.docs.map(d => [d.path, d.data, d.pending]), meta]);
    if (key === l.last) return;
    l.last = key;
    try {
      if (l.doc) l.cb(new DocSnap(this.db, l.doc, v.data, meta));
      else {
        const snap = new QuerySnap(this.db, v.docs, meta, l.prev);
        l.prev = new Map(v.docs.map(d => [d.path, JSON.stringify(d.data)]));
        l.cb(snap);
      }
    } catch (e) { console.error(e); }
  }
  notify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => { this.notifyQueued = false; for (const l of this.listeners) this.emit(l); });
  }
  subscribe(l) {
    if (!this.listeners.has(l)) return;
    this.connect();
    if (!this.online) return;
    const sid = 's' + ++this.seq;
    this.subs.set(sid, l);
    this.send(l.doc ? { t: 'sub', id: sid, doc: l.doc } : { t: 'sub', id: sid, q: l.q });
  }

  // ---- writes ----
  write(ops) {
    const batch = { id: newId(), at: Date.now(), ops: ops.map(o => ({ op: o.op, path: o.path, ...(o.data !== undefined && { data: clone(o.data) }), ...(o.merge && { merge: true }) })) };
    for (const op of batch.ops) parseDocPath(op.path);
    let resolve, reject;
    const p = new Promise((a, b) => { resolve = a; reject = b; });
    p.catch(() => {});
    this.waiters.set(batch.id, { resolve, reject });
    this.ready.then(() => {
      this.queue.push(batch);
      this.persist('queue', this.queue);
      this.notify();
      this.flushQueue();
    });
    return p;
  }
  flushQueue() {
    if (!this.queue.length) return;
    if (typeof WebSocket === 'undefined') return this.flushHttp();
    this.connect();
    if (!this.online) return;
    for (const b of this.queue) if (!this.inflight.has(b.id)) { this.inflight.add(b.id); this.send({ t: 'commit', id: b.id, batch: b.id, ops: b.ops }); }
  }
  async flushHttp() {
    if (this.httpFlushing || !this.network) return;
    this.httpFlushing = true;
    try {
      while (this.queue.length) {
        const b = this.queue[0];
        try { this.acked(b.id, await this.http('db/commit', { body: { ops: b.ops, batch: b.id } })); }
        catch (e) { if (e.code === 'unavailable') break; this.rejected(b.id, e); }
      }
    } finally { this.httpFlushing = false; }
  }
  acked(id, res) {
    this.inflight.delete(id);
    this.queue = this.queue.filter(b => b.id !== id);
    this.persist('queue', this.queue);
    for (const d of res.docs || []) this.setDoc(d.path, d.data, d.updated);
    this.waiters.get(id)?.resolve();
    this.waiters.delete(id);
    for (const f of [...this.drains]) f();
    this.notify();
  }
  rejected(id, e) {
    this.inflight.delete(id);
    this.queue = this.queue.filter(b => b.id !== id);
    this.persist('queue', this.queue);
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    if (w) w.reject(e);
    else for (const cb of this.errorCbs) cb(e);
    for (const f of [...this.drains]) f();
    this.notify();
  }

  // ---- connection ----
  get connected() { return this.online; }
  onConnectionChange(cb) { this.connCbs.add(cb); cb(this.online); return () => this.connCbs.delete(cb); }
  onError(cb) { this.errorCbs.add(cb); return () => this.errorCbs.delete(cb); }
  setOnline(v) {
    if (this.online === v) return;
    this.online = v;
    for (const cb of this.connCbs) try { cb(v); } catch (e) { console.error(e); }
  }
  connect() {
    if (!this.network || this.ws || typeof WebSocket === 'undefined') return;
    if (!this.listeners.size && !this.queue.length) return;
    clearTimeout(this.retryTimer);
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => this.hello();
    ws.onmessage = e => { try { this.onMessage(JSON.parse(e.data)); } catch (x) { console.error(x); } };
    ws.onclose = () => { if (this.ws === ws) { this.dropSocket(); this.retry(); } };
    ws.onerror = () => {};
  }
  async hello() {
    const token = await this.currentToken().catch(() => null);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'hello', token }));
  }
  // Called when the signed-in user (or their token) changes
  rehello(resubscribe) {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (resubscribe) {
      for (const sid of this.subs.keys()) this.send({ t: 'unsub', id: sid });
      this.subs.clear();
      for (const l of this.listeners) l.synced = false;
      this.resubscribe = true;
    }
    this.hello();
  }
  dropSocket() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingTimer);
    this.inflight.clear();
    this.subs.clear();
    for (const [, r] of this.pending) r.reject(err('unavailable', 'Connection lost'));
    this.pending.clear();
    for (const l of this.listeners) l.synced = false;
    this.setOnline(false);
    this.notify();
    try { ws?.close(); } catch {}
  }
  retry() {
    if (!this.network) return;
    const d = Math.min(30000, 500 * 2 ** this.backoff++);
    this.retryTimer = unref(setTimeout(() => this.connect(), d + Math.random() * 250));
  }
  send(m) { try { this.ws?.send(JSON.stringify(m)); } catch {} }

  onMessage(m) {
    if (m.t === 'ready') {
      const first = !this.online || this.resubscribe;
      this.resubscribe = false;
      this.backoff = 0;
      this.helloFails = 0;
      this.setOnline(true);
      clearInterval(this.pingTimer);
      this.pingTimer = unref(setInterval(() => this.send({ t: 'ping' }), 25000));
      if (first) for (const l of this.listeners) if (![...this.subs.values()].includes(l)) this.subscribe(l);
      this.flushQueue();
    } else if (m.t === 'snap') {
      const l = this.subs.get(m.id);
      if (!l || !this.listeners.has(l)) return;
      if (l.doc) this.setDoc(l.doc, m.doc?.data ?? null, m.doc?.updated);
      else {
        const key = queryKey(l.q);
        const paths = m.docs.map(d => d.path);
        const now = new Set(paths);
        if (m.docs.length < l.q.limit) {
          // A cached doc that still matches the filters but vanished from the result was deleted
          for (const p of this.queries.get(key) || []) {
            const d = this.docs.get(p);
            if (!now.has(p) && d && l.q.where.every(w => matches({ id: idOf(p), data: d.data }, w))) this.setDoc(p, null);
          }
        }
        for (const d of m.docs) this.setDoc(d.path, d.data, d.updated);
        this.queries.set(key, paths);
        this.persist('q:' + key, paths);
      }
      l.synced = true;
      this.notify();
    } else if (m.t === 'ack') this.acked(m.id, m);
    else if (m.t === 'res') { const r = this.pending.get(m.id); this.pending.delete(m.id); r?.resolve(m); }
    else if (m.t === 'err') {
      const e = err(m.code, m.message);
      if (m.of === 'hello') {
        if ((this.helloFails = (this.helloFails || 0) + 1) > 2) return this.auth._set(null);
        return this.auth._refresh().then(() => this.hello());
      }
      if (m.of === 'commit') return this.rejected(m.id, e);
      if (m.of === 'sub') {
        const l = this.subs.get(m.id);
        this.subs.delete(m.id);
        if (l) { this.listeners.delete(l); if (l.err) l.err(e); else console.error('[rennko] listener stopped:', e.message); }
        return;
      }
      const r = this.pending.get(m.id);
      this.pending.delete(m.id);
      r?.reject(e);
    }
  }

  request(msg, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = 'r' + ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.send({ ...msg, id });
      unref(setTimeout(() => { if (this.pending.delete(id)) reject(err('unavailable', 'Request timed out')); }, timeout));
    });
  }

  async currentToken() {
    if (this.fixedToken) return typeof this.fixedToken === 'function' ? this.fixedToken() : this.fixedToken;
    return this.auth.getToken();
  }

  async http(route, { method = 'POST', body, auth = true, headers = {}, raw = false, retried = false } = {}) {
    if (!this.network) throw err('unavailable', 'Network is disabled');
    const h = { ...headers };
    let b = body;
    const binary = b != null && (typeof Blob !== 'undefined' && b instanceof Blob || b instanceof ArrayBuffer || ArrayBuffer.isView(b) || typeof b === 'string' && raw);
    if (b !== undefined && !binary) { h['content-type'] = 'application/json'; b = JSON.stringify(b); }
    const tok = auth ? await this.currentToken().catch(() => null) : null;
    if (tok) h.authorization = 'Bearer ' + tok;
    let r;
    try { r = await fetch(this.url + '/__/' + route, { method, headers: h, body: b }); }
    catch { throw err('unavailable', "Can't reach the server (offline?)"); }
    if (r.status === 401 && tok && !this.fixedToken && !retried && !route.startsWith('auth/')) {
      await this.auth._refresh();
      return this.http(route, { method, body, auth, headers, raw, retried: true });
    }
    if (raw && r.ok) return r;
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : { error: { message: await r.text() } };
    if (!r.ok) throw err(data?.error?.code || 'internal', data?.error?.message || r.statusText);
    return data;
  }

  disableNetwork() { this.network = false; clearTimeout(this.retryTimer); this.dropSocket(); return Promise.resolve(); }
  enableNetwork() { this.network = true; this.backoff = 0; this.connect(); if (typeof WebSocket === 'undefined') this.flushHttp(); return Promise.resolve(); }
  // Resolves once every queued write has reached the server
  async waitForPendingWrites() {
    await this.ready;
    const ids = new Set(this.queue.map(b => b.id));
    if (!ids.size) return;
    this.flushQueue();
    await new Promise(res => {
      const check = () => { if (!this.queue.some(b => ids.has(b.id))) { this.drains.delete(check); res(); } };
      this.drains.add(check);
    });
  }
  async close() {
    this.network = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.auth.timer);
    this.dropSocket();
    this.listeners.clear();
    clearTimeout(this.saveTimer);
    await this.flushSave();
    apps.delete(this.url);
  }
}

// ---- auth ----
class Auth {
  constructor(app) { this.app = app; this.s = null; this.user = null; this.cbs = new Set(); this.loaded = false; }
  get currentUser() { return this.user; }
  _load(s) { this.s = s; this.user = s?.user || null; this.loaded = true; this._emit(); this._schedule(); }
  onAuthChange(cb) { this.cbs.add(cb); if (this.loaded) cb(this.user); return () => this.cbs.delete(cb); }
  _emit() { for (const cb of this.cbs) try { cb(this.user); } catch (e) { console.error(e); } }
  async _set(res) {
    const prevUser = JSON.stringify(this.user);
    const prev = this.user?.uid;
    this.s = res ? { user: res.user, token: res.token, refreshToken: res.refreshToken, exp: Date.now() + res.expiresIn * 1000 } : null;
    this.user = this.s?.user || null;
    this.app.persist('auth', this.s ?? undefined);
    const changed = prev !== this.user?.uid;
    if (changed && prev) await this.app.clearCache();
    this.app.rehello(changed);
    if (prevUser !== JSON.stringify(this.user)) this._emit();
    this._schedule();
    return this.user;
  }
  _schedule() {
    clearTimeout(this.timer);
    if (this.s) this.timer = unref(setTimeout(() => this._refresh(), Math.max(10e3, this.s.exp - Date.now() - 300e3)));
  }
  async getToken(force) {
    await this.app.ready;
    if (!this.s) return null;
    if (force || this.s.exp - Date.now() < 300e3) await this._refresh();
    return this.s?.token ?? null;
  }
  _refresh() {
    if (!this.s) return Promise.resolve();
    return (this._r ??= (async () => {
      try { await this._set(await this.app.http('auth/refresh', { body: { refreshToken: this.s.refreshToken }, auth: false })); }
      catch (e) { if (e.code === 'unauthenticated') await this._set(null); }
      finally { this._r = null; }
    })());
  }
  async _call(route, body, auth = false) {
    await this.app.ready;
    return this._set(await this.app.http('auth/' + route, { body, auth }));
  }
  signUp(email, password, name) { return this._call('signup', { email, password, name }, !!this.user?.anon); }
  signIn(email, password) { return this._call('signin', { email, password }); }
  signInAnonymously() { return this._call('anon', {}); }
  async signInWithGoogle(idToken) {
    if (!idToken) idToken = await googlePrompt(this.app);
    return this._call('google', { idToken });
  }
  // Renders Google's own sign-in button into `el`; signs in when it's clicked.
  async renderGoogleButton(el, options = {}) {
    const { googleClientId } = await this.app.http('info', { method: 'GET', auth: false });
    if (!googleClientId) throw err('failed-precondition', 'Add a Google client ID to this project in the console first');
    await loadGsi();
    google.accounts.id.initialize({ client_id: googleClientId, callback: r => this._call('google', { idToken: r.credential }).catch(e => options.onError?.(e)) });
    google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', ...options });
  }
  async signOut() {
    if (this.s?.refreshToken) this.app.http('auth/signout', { body: { refreshToken: this.s.refreshToken }, auth: false }).catch(() => {});
    await this._set(null);
  }
  async updateProfile(p) { return this._set(await this.app.http('auth/update', { body: p })); }
  async updatePassword(password) { return this._set(await this.app.http('auth/update', { body: { password } })); }
  async deleteAccount() { await this.app.http('auth/delete', { body: {} }); await this._set(null); }
}

let gsi;
function loadGsi() {
  return (gsi ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => rej(err('unavailable', "Couldn't load Google sign-in"));
    document.head.appendChild(s);
  }));
}
async function googlePrompt(app) {
  const { googleClientId } = await app.http('info', { method: 'GET', auth: false });
  if (!googleClientId) throw err('failed-precondition', 'Add a Google client ID to this project in the console first');
  await loadGsi();
  return new Promise((res, rej) => {
    google.accounts.id.initialize({ client_id: googleClientId, callback: r => res(r.credential) });
    google.accounts.id.prompt(n => { if (n.isNotDisplayed?.() || n.isSkippedMoment?.()) rej(err('cancelled', 'Google sign-in was closed. Try auth.renderGoogleButton() instead.')); });
  });
}

// ---- database ----
class Db {
  constructor(app) { this.app = app; }
  collection(path) { return new Query(this.app, { col: checkColPath(path) }); }
  doc(path) { return new DocRef(this.app, path); }
  batch() { return new WriteBatch(this.app); }
}

class DocRef {
  constructor(app, path) {
    parseDocPath(path);
    this.app = app;
    this.path = path;
    this.id = idOf(path);
  }
  get parent() { return new Query(this.app, { col: colOf(this.path) }); }
  collection(sub) { return new Query(this.app, { col: checkColPath(`${this.path}/${sub}`) }); }
  set(data, opts = {}) { return this.app.write([{ op: 'set', path: this.path, data, merge: !!opts.merge }]); }
  update(data) { return this.app.write([{ op: 'update', path: this.path, data }]); }
  delete() { return this.app.write([{ op: 'delete', path: this.path }]); }
  async get(opts = {}) {
    const app = this.app;
    await app.ready;
    if (opts.source !== 'cache') {
      try {
        const res = app.online ? await app.request({ t: 'get', path: this.path }) : await app.http('db/get', { body: { path: this.path } });
        app.setDoc(this.path, res.doc?.data ?? null, res.doc?.updated);
        const v = app.localDoc(this.path);
        return new DocSnap(app.db, this.path, v.data, { fromCache: false, hasPendingWrites: v.pending });
      } catch (e) { if (e.code !== 'unavailable' || opts.source === 'server') throw e; }
    }
    const v = app.localDoc(this.path);
    return new DocSnap(app.db, this.path, v.data, { fromCache: true, hasPendingWrites: v.pending });
  }
  onSnapshot(cb, onError) { return this.app.listen({ doc: this.path, cb, err: onError }); }
}

class Query {
  constructor(app, q) { this.app = app; this.q = q; }
  get path() { return this.q.col; }
  doc(id = newId()) { return new DocRef(this.app, `${this.q.col}/${id}`); }
  async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
  where(field, op, value) { return new Query(this.app, { ...this.q, where: [...(this.q.where || []), [field, op, value]] }); }
  orderBy(field, dir = 'asc') { return new Query(this.app, { ...this.q, orderBy: [...(this.q.orderBy || []), [field, dir]] }); }
  limit(n) { return new Query(this.app, { ...this.q, limit: n }); }
  offset(n) { return new Query(this.app, { ...this.q, offset: n }); }
  async get(opts = {}) {
    const app = this.app;
    const q = normQuery(this.q);
    await app.ready;
    let fromCache = true;
    if (opts.source !== 'cache') {
      try {
        const res = app.online ? await app.request({ t: 'query', q }) : await app.http('db/query', { body: { q } });
        for (const d of res.docs) app.setDoc(d.path, d.data, d.updated);
        app.queries.set(queryKey(q), res.docs.map(d => d.path));
        app.persist('q:' + queryKey(q), res.docs.map(d => d.path));
        fromCache = false;
      } catch (e) { if (e.code !== 'unavailable' || opts.source === 'server') throw e; }
    }
    const v = app.localQuery(q);
    return new QuerySnap(app.db, v.docs, { fromCache, hasPendingWrites: v.pending });
  }
  onSnapshot(cb, onError) { return this.app.listen({ q: normQuery(this.q), cb, err: onError }); }
}

class WriteBatch {
  constructor(app) { this.app = app; this.ops = []; }
  set(ref, data, opts = {}) { this.ops.push({ op: 'set', path: ref.path ?? ref, data, merge: !!opts.merge }); return this; }
  update(ref, data) { this.ops.push({ op: 'update', path: ref.path ?? ref, data }); return this; }
  delete(ref) { this.ops.push({ op: 'delete', path: ref.path ?? ref }); return this; }
  commit() { return this.ops.length ? this.app.write(this.ops) : Promise.resolve(); }
}

class DocSnap {
  constructor(db, path, data, metadata) {
    this.ref = db.doc(path);
    this.id = idOf(path);
    this.path = path;
    this.exists = data != null;
    this.metadata = metadata;
    this._d = data;
  }
  data() { return this._d == null ? undefined : clone(this._d); }
  get(field) { let v = this._d; for (const k of field.split('.')) v = v?.[k]; return clone(v); }
}

class QuerySnap {
  constructor(db, docs, metadata, prev) {
    this.metadata = metadata;
    this.docs = docs.map(d => new DocSnap(db, d.path, d.data, { fromCache: metadata.fromCache, hasPendingWrites: !!d.pending }));
    this.size = this.docs.length;
    this.empty = !this.size;
    this._prev = prev;
  }
  forEach(fn) { this.docs.forEach(fn); }
  // What changed since this listener's previous snapshot
  docChanges() {
    const prev = this._prev || new Map();
    const seen = new Set();
    const out = [];
    this.docs.forEach((doc, i) => {
      seen.add(doc.path);
      if (!prev.has(doc.path)) out.push({ type: 'added', doc, newIndex: i });
      else if (prev.get(doc.path) !== JSON.stringify(doc._d)) out.push({ type: 'modified', doc, newIndex: i });
    });
    for (const p of prev.keys()) if (!seen.has(p)) out.push({ type: 'removed', doc: { id: idOf(p), path: p }, newIndex: -1 });
    return out;
  }
}

// ---- storage (needs a connection) ----
class Storage {
  constructor(app) { this.app = app; }
  upload(path, data, { contentType } = {}) {
    const type = contentType || data?.type || 'application/octet-stream';
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return this.app.http('storage/o/' + encPath(path), { method: 'PUT', body, headers: { 'content-type': type } });
  }
  meta(path) { return this.app.http('storage/meta/' + encPath(path), { method: 'GET' }); }
  async getUrl(path) { return (await this.meta(path)).url; }
  async download(path) { const r = await this.app.http('storage/o/' + encPath(path), { method: 'GET', raw: true }); return r.blob(); }
  async list(prefix = '') { return (await this.app.http('storage/list?prefix=' + encodeURIComponent(prefix), { method: 'GET' })).files; }
  delete(path) { return this.app.http('storage/o/' + encPath(path), { method: 'DELETE' }); }
}
