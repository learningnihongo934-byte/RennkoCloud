// One Durable Object per project. It holds everything for that project in its own SQLite:
// users and sessions, documents, live subscriptions, stored files and the hosted site.
import { DurableObject } from 'cloudflare:workers';
import { applyOp, parseDocPath, normQuery, newId, err } from '../public/rennko-core.js';
import { signToken, verifyToken, hashPassword, checkPassword, randomToken, sha256hex, verifyGoogleIdToken } from './crypto.js';
import { allowed, validateRules, DEFAULT_RULES, LOCKED_RULES } from './rules.js';

const CHUNK = 1536 * 1024; // SQLite rows top out at 2 MB
const TOKEN_TTL = 3600;
const SESSION_DAYS = 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users(uid TEXT PRIMARY KEY, email TEXT UNIQUE, pass TEXT, provider TEXT, gsub TEXT, name TEXT, photo TEXT, created INTEGER, last INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, uid TEXT, expires INTEGER);
CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, col TEXT, id TEXT, data TEXT, created INTEGER, updated INTEGER);
CREATE INDEX IF NOT EXISTS docs_col ON docs(col, id);
CREATE TABLE IF NOT EXISTS applied(id TEXT PRIMARY KEY, at INTEGER);
CREATE TABLE IF NOT EXISTS subs(sock TEXT, id TEXT, col TEXT, dpath TEXT, spec TEXT, hash TEXT, PRIMARY KEY(sock, id));
CREATE INDEX IF NOT EXISTS subs_col ON subs(col);
CREATE INDEX IF NOT EXISTS subs_path ON subs(dpath);
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER, type TEXT, token TEXT, owner TEXT, hash TEXT, created INTEGER, updated INTEGER);
CREATE TABLE IF NOT EXISTS site(path TEXT PRIMARY KEY, hash TEXT, type TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS blobmeta(hash TEXT PRIMARY KEY, size INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS blobs(hash TEXT, n INTEGER, data BLOB, PRIMARY KEY(hash, n));
CREATE TABLE IF NOT EXISTS registry(id TEXT PRIMARY KEY, owner TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS registry_owner ON registry(owner);
`;

const STATUS = { 'invalid-argument': 400, unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, 'failed-precondition': 412, 'payload-too-large': 413, 'resource-exhausted': 429 };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const errorResponse = e => json({ error: { code: e.code || 'internal', message: e.message || 'Server error' } }, STATUS[e.code] || 500);

const MIME = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm', xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', webmanifest: 'application/manifest+json' };
const mimeOf = path => MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FILE_PATH = /^(?!.*\/\/)(?!\/)[^\0]{1,500}(?<!\/)$/;

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + s.length;
}

const authVar = a => (a && !a.admin ? { uid: a.uid, email: a.email ?? null, anon: !!a.anon, provider: a.provider ?? null, name: a.name ?? null } : null);

export class Project extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  // ---- helpers ----
  get exists() {
    if (this._exists) return true;
    this._exists = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").toArray().length > 0 && !!this.meta('id');
    return this._exists;
  }
  meta(k) {
    const r = this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray()[0];
    return r ? JSON.parse(r.v) : undefined;
  }
  setMeta(k, v) {
    this.sql.exec('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)', k, JSON.stringify(v));
  }
  get pid() { return (this._pid ??= this.meta('id')); }
  rules() { return (this._rules ??= this.meta('rules') || DEFAULT_RULES); }
  cap() { return Number(this.env.PROJECT_CAP_MB || 500) * 1048576; }
  count(table) { return this.sql.exec(`SELECT COUNT(*) n FROM ${table}`).one().n; }

  init(id, owner) {
    this.sql.exec(SCHEMA);
    this.setMeta('id', id);
    this.setMeta('owner', owner);
    this.setMeta('created', Date.now());
    this.setMeta('adminKey', 'rk_' + randomToken(24));
    this.setMeta('rules', id === 'console' ? LOCKED_RULES : DEFAULT_RULES);
    this.setMeta('settings', {});
    this._exists = true;
    this._pid = id;
    this._rules = null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const route = url.pathname.startsWith('/__/') ? url.pathname.slice(4) : null;
    try {
      const pid = req.headers.get('x-rk-project');
      if (!this.exists) {
        if (pid === 'console') this.init('console', null);
        else if (route === 'admin/init' && req.headers.get('x-rk-internal') === '1') {
          const { owner } = await req.json();
          this.init(pid, owner);
          return json({ ok: true });
        } else if (route === null) return this.page(404, 'Nothing here yet', `There's no Rennko Cloud project called <b>${esc(pid)}</b>.`);
        else throw err('not-found', `No project "${pid}"`);
      }
      this.origin = req.headers.get('x-rk-origin') || url.origin;
      if (route === null) return await this.serveSite(req, url);
      return await this.api(req, url, route);
    } catch (e) {
      if (!e.code) console.error(e);
      return errorResponse(e);
    }
  }

  async authFromToken(tok) {
    if (!tok) return null;
    const c = await verifyToken(this.env.SECRET, tok);
    if (!c) throw err('unauthenticated', 'Session expired or invalid, sign in again');
    if (c.p === this.pid) return { uid: c.uid, email: c.email ?? null, anon: !!c.anon, provider: c.provider ?? null, name: c.name ?? null };
    if (c.p === 'console' && c.uid && c.uid === this.meta('owner')) return { admin: true, uid: c.uid };
    throw err('permission-denied', 'That token is for a different project');
  }

  async authFrom(req) {
    if (req.headers.get('x-rk-internal') === '1') return { admin: true, uid: 'internal' };
    const key = req.headers.get('x-admin-key');
    if (key) {
      if (key !== this.meta('adminKey')) throw err('permission-denied', 'Wrong admin key');
      return { admin: true, uid: 'admin-key' };
    }
    const h = req.headers.get('authorization') || '';
    return this.authFromToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  }

  // ---- routes ----
  async api(req, url, route) {
    const m = req.method;
    const body = async () => { try { return await req.json(); } catch { throw err('invalid-argument', 'Expected a JSON body'); } };
    if (route === 'info' && m === 'GET') return json({ id: this.pid, googleClientId: this.meta('settings')?.googleClientId || null });
    if (route === 'ws') return this.wsConnect(req);

    // auth endpoints read their own credentials
    if (route.startsWith('auth/')) return json(await this.authRoute(route.slice(5), m, req, body));

    const auth = await this.authFrom(req);
    const needAdmin = () => { if (!auth?.admin) throw err('permission-denied', 'Only the project owner can do this'); };

    if (route === 'db/get' && m === 'POST') return json(this.dbGet(auth, (await body()).path));
    if (route === 'db/query' && m === 'POST') return json(this.dbQuery(auth, (await body()).q));
    if (route === 'db/commit' && m === 'POST') { const b = await body(); return json(this.commit(auth, b.ops, b.batch)); }

    if (route.startsWith('storage/o/')) {
      const path = decodeURIComponent(route.slice(10));
      if (m === 'PUT' || m === 'POST') return json(await this.filePut(req, auth, path));
      if (m === 'GET' || m === 'HEAD') return this.fileGet(auth, path, url.searchParams.get('t'));
      if (m === 'DELETE') return json(this.fileDelete(auth, path));
    }
    if (route.startsWith('storage/meta/') && m === 'GET') return json(this.fileMeta(auth, decodeURIComponent(route.slice(13))));
    if (route === 'storage/list' && m === 'GET') return json(this.fileList(auth, url.searchParams.get('prefix') || ''));

    if (route.startsWith('hosting/')) {
      needAdmin();
      if (route === 'hosting/plan' && m === 'POST') return json(this.hostingPlan(await body()));
      if (route.startsWith('hosting/blob/') && m === 'PUT') return json(await this.hostingBlob(route.slice(13), await req.arrayBuffer()));
      if (route === 'hosting/release' && m === 'POST') return json(this.hostingRelease(await body()));
      if (route === 'hosting/info' && m === 'GET') return json(this.meta('hosting') || null);
    }

    if (route.startsWith('admin/')) {
      needAdmin();
      return json(await this.adminRoute(route.slice(6), m, url, body));
    }

    if (route.startsWith('registry/') && this.pid === 'console') {
      if (req.headers.get('x-rk-internal') !== '1') throw err('permission-denied', 'Internal only');
      return json(await this.registryRoute(route.slice(9), url, body));
    }
    throw err('not-found', `Unknown endpoint ${m} /__/${route}`);
  }

  // ---- auth ----
  pubUser(u) {
    return { uid: u.uid, email: u.email, name: u.name, photo: u.photo, provider: u.provider, anon: u.provider === 'anonymous', created: u.created };
  }
  user(uid) { return this.sql.exec('SELECT * FROM users WHERE uid=?', uid).toArray()[0]; }
  async session(u, refresh) {
    const now = Date.now();
    if (!refresh) {
      refresh = randomToken();
      this.sql.exec('INSERT INTO sessions(id, uid, expires) VALUES(?, ?, ?)', await sha256hex(refresh), u.uid, now + SESSION_DAYS * 864e5);
    }
    this.sql.exec('UPDATE users SET last=? WHERE uid=?', now, u.uid);
    if (Math.random() < 0.02) this.sql.exec('DELETE FROM sessions WHERE expires < ?', now);
    const token = await signToken(this.env.SECRET, this.pid, { uid: u.uid, email: u.email, anon: u.provider === 'anonymous', provider: u.provider, name: u.name }, TOKEN_TTL);
    return { user: this.pubUser(u), token, refreshToken: refresh, expiresIn: TOKEN_TTL };
  }

  async authRoute(r, m, req, body) {
    const now = Date.now();
    if (r === 'signup' && m === 'POST') {
      const { email: e, password, name } = await body();
      const email = String(e || '').trim().toLowerCase();
      if (!EMAIL.test(email)) throw err('invalid-argument', 'Enter a valid email');
      if (String(password || '').length < 6) throw err('invalid-argument', 'Password must be at least 6 characters');
      if (this.sql.exec('SELECT 1 FROM users WHERE email=?', email).toArray().length) throw err('already-exists', 'That email already has an account');
      const pass = await hashPassword(password);
      // Signing up while signed in anonymously keeps the same uid (and the user's data)
      const cur = await this.authFrom(req).catch(() => null);
      if (cur?.anon && this.user(cur.uid)) {
        this.sql.exec("UPDATE users SET email=?, pass=?, provider='password', name=COALESCE(?, name) WHERE uid=?", email, pass, name || null, cur.uid);
        return this.session(this.user(cur.uid));
      }
      const uid = newId();
      this.sql.exec("INSERT INTO users(uid, email, pass, provider, name, created, last) VALUES(?, ?, ?, 'password', ?, ?, ?)", uid, email, pass, name || null, now, now);
      return this.session(this.user(uid));
    }
    if (r === 'signin' && m === 'POST') {
      const { email: e, password } = await body();
      const u = this.sql.exec('SELECT * FROM users WHERE email=?', String(e || '').trim().toLowerCase()).toArray()[0];
      if (!u || !u.pass || !(await checkPassword(String(password || ''), u.pass))) throw err('unauthenticated', 'Wrong email or password');
      return this.session(u);
    }
    if (r === 'anon' && m === 'POST') {
      const uid = newId();
      this.sql.exec("INSERT INTO users(uid, provider, created, last) VALUES(?, 'anonymous', ?, ?)", uid, now, now);
      return this.session(this.user(uid));
    }
    if (r === 'google' && m === 'POST') {
      const { idToken } = await body();
      const g = await verifyGoogleIdToken(idToken, this.meta('settings')?.googleClientId);
      const email = g.email_verified ? String(g.email).toLowerCase() : null;
      let u = this.sql.exec('SELECT * FROM users WHERE gsub=?', g.sub).toArray()[0] || (email && this.sql.exec('SELECT * FROM users WHERE email=?', email).toArray()[0]);
      if (u) this.sql.exec('UPDATE users SET gsub=?, name=COALESCE(name, ?), photo=COALESCE(photo, ?) WHERE uid=?', g.sub, g.name || null, g.picture || null, u.uid);
      else {
        const uid = newId();
        this.sql.exec("INSERT INTO users(uid, email, provider, gsub, name, photo, created, last) VALUES(?, ?, 'google', ?, ?, ?, ?, ?)", uid, email, g.sub, g.name || null, g.picture || null, now, now);
      }
      u = this.sql.exec('SELECT * FROM users WHERE gsub=?', g.sub).one();
      return this.session(u);
    }
    if (r === 'refresh' && m === 'POST') {
      const { refreshToken } = await body();
      const s = this.sql.exec('SELECT * FROM sessions WHERE id=?', await sha256hex(String(refreshToken || ''))).toArray()[0];
      const u = s && s.expires > now && this.user(s.uid);
      if (!u) throw err('unauthenticated', 'Session expired, sign in again');
      this.sql.exec('UPDATE sessions SET expires=? WHERE id=?', now + SESSION_DAYS * 864e5, s.id);
      return this.session(u, refreshToken);
    }
    if (r === 'signout' && m === 'POST') {
      const { refreshToken } = await body();
      if (refreshToken) this.sql.exec('DELETE FROM sessions WHERE id=?', await sha256hex(String(refreshToken)));
      return { ok: true };
    }
    const me = await this.authFrom(req);
    if (!me || me.admin) throw err('unauthenticated', 'Sign in first');
    const u = this.user(me.uid);
    if (!u) throw err('unauthenticated', 'This account no longer exists');
    if (r === 'me' && m === 'GET') return { user: this.pubUser(u) };
    if (r === 'update' && m === 'POST') {
      const { name, photo, password } = await body();
      if (password != null) {
        if (String(password).length < 6) throw err('invalid-argument', 'Password must be at least 6 characters');
        this.sql.exec('UPDATE users SET pass=? WHERE uid=?', await hashPassword(String(password)), u.uid);
      }
      if (name !== undefined) this.sql.exec('UPDATE users SET name=? WHERE uid=?', name, u.uid);
      if (photo !== undefined) this.sql.exec('UPDATE users SET photo=? WHERE uid=?', photo, u.uid);
      return this.session(this.user(u.uid));
    }
    if (r === 'delete' && m === 'POST') {
      this.deleteUser(u.uid);
      return { ok: true };
    }
    throw err('not-found', `Unknown endpoint /__/auth/${r}`);
  }

  deleteUser(uid) {
    this.sql.exec('DELETE FROM sessions WHERE uid=?', uid);
    this.sql.exec('DELETE FROM users WHERE uid=?', uid);
  }

  // ---- database ----
  readDoc(path) {
    const r = this.sql.exec('SELECT data, updated FROM docs WHERE path=?', path).toArray()[0];
    return r ? { data: JSON.parse(r.data), updated: r.updated } : null;
  }

  can(auth, section, path, action, doc, data) {
    if (auth?.admin) return true;
    return allowed(this.rules()[section], path, action, { auth: authVar(auth), doc: doc ?? null, data: data ?? null, now: Date.now() });
  }

  dbGet(auth, path) {
    const { id } = parseDocPath(path);
    const row = this.readDoc(path);
    if (!this.can(auth, 'db', path, 'get', row?.data, row?.data)) throw err('permission-denied', `Missing permission to read ${path}`);
    return { doc: row ? { path, id, data: row.data, updated: row.updated } : null };
  }

  dbQuery(auth, rawQ) {
    const q = normQuery(rawQ || {});
    const where = ['col = ?'];
    const args = [q.col];
    const jp = f => '$' + f.split('.').map(k => `."${k}"`).join('');
    const ex = f => (f === '__id' ? 'id' : `json_extract(data, '${jp(f)}')`);
    const val = v => (typeof v === 'boolean' ? Number(v) : v && typeof v === 'object' ? JSON.stringify(v) : v);
    const typeGuard = (f, v) => (f === '__id' ? '' : typeof v === 'number' ? ` AND json_type(data, '${jp(f)}') IN ('integer','real')` : typeof v === 'string' ? ` AND json_type(data, '${jp(f)}') = 'text'` : '');
    for (const [f, op, v] of q.where) {
      const e = ex(f);
      if (op === '==') { if (v === null) where.push(`${e} IS NULL`); else { where.push(`${e} = ?`); args.push(val(v)); } }
      else if (op === '!=') { where.push(`${e} IS NOT NULL AND ${e} != ?`); args.push(val(v)); }
      else if (['<', '<=', '>', '>='].includes(op)) { where.push(`(${e} ${op} ?${typeGuard(f, v)})`); args.push(val(v)); }
      else if (op === 'in' || op === 'not-in') {
        const ph = v.map(() => '?').join(',') || 'NULL';
        where.push(op === 'in' ? `${e} IN (${ph})` : `${e} IS NOT NULL AND ${e} NOT IN (${ph})`);
        args.push(...v.map(val));
      } else if (op === 'array-contains') { where.push(`EXISTS (SELECT 1 FROM json_each(data, '${jp(f)}') WHERE value = ?)`); args.push(val(v)); }
      else if (op === 'array-contains-any') {
        where.push(`EXISTS (SELECT 1 FROM json_each(data, '${jp(f)}') WHERE value IN (${v.map(() => '?').join(',') || 'NULL'}))`);
        args.push(...v.map(val));
      }
    }
    const order = [...q.orderBy.map(([f, d]) => `${ex(f)} ${d === 'desc' ? 'DESC' : 'ASC'}`), 'id ASC'].join(', ');
    const rows = this.sql.exec(`SELECT path, id, data, updated FROM docs WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, q.limit, q.offset).toArray();
    const docs = [];
    for (const r of rows) {
      const data = JSON.parse(r.data);
      if (this.can(auth, 'db', r.path, 'list', data, data)) docs.push({ path: r.path, id: r.id, data, updated: r.updated });
    }
    return { docs };
  }

  commit(auth, ops, batch) {
    if (!Array.isArray(ops) || !ops.length || ops.length > 500) throw err('invalid-argument', 'A commit needs 1 to 500 operations');
    const now = Date.now();
    if (batch && this.sql.exec('SELECT 1 FROM applied WHERE id=?', String(batch)).toArray().length) {
      return { docs: [...new Set(ops.map(o => o.path))].map(path => ({ path, id: parseDocPath(path).id, data: this.readDoc(path)?.data ?? null, updated: now })), duplicate: true };
    }
    if (ops.some(o => o.op !== 'delete') && this.sql.databaseSize > this.cap()) throw err('resource-exhausted', 'This project is out of storage space');
    const staged = new Map();
    this.ctx.storage.transactionSync(() => {
      for (const op of ops) {
        parseDocPath(op.path);
        const before = staged.has(op.path) ? staged.get(op.path) : this.readDoc(op.path)?.data ?? null;
        const after = applyOp(op, before, now);
        if (after && JSON.stringify(after).length > 1_000_000) throw err('invalid-argument', 'Documents must be under 1 MB');
        const action = after == null ? 'delete' : before == null ? 'create' : 'update';
        if (!this.can(auth, 'db', op.path, action, before, after)) throw err('permission-denied', `Missing permission to ${action} ${op.path}`);
        staged.set(op.path, after);
      }
      for (const [path, data] of staged) {
        if (data == null) { this.sql.exec('DELETE FROM docs WHERE path=?', path); continue; }
        const { col, id } = parseDocPath(path);
        this.sql.exec('INSERT INTO docs(path, col, id, data, created, updated) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated', path, col, id, JSON.stringify(data), now, now);
      }
      if (batch) this.sql.exec('INSERT OR IGNORE INTO applied(id, at) VALUES(?, ?)', String(batch), now);
    });
    if (Math.random() < 0.01) this.sql.exec('DELETE FROM applied WHERE at < ?', now - 7 * 864e5);
    this.broadcast([...staged.keys()]);
    return { docs: [...staged].map(([path, data]) => ({ path, id: parseDocPath(path).id, data, updated: now })) };
  }

  // ---- realtime (hibernating WebSockets) ----
  wsConnect(req) {
    if (req.headers.get('upgrade') !== 'websocket') throw err('invalid-argument', 'Expected a WebSocket upgrade');
    const [client, server] = Object.values(new WebSocketPair());
    const sid = newId();
    this.ctx.acceptWebSocket(server, [sid]);
    server.serializeAttachment({ sid, auth: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  runSpec(spec, auth) {
    if (spec.doc) return { doc: this.dbGet(auth, spec.doc).doc };
    return { docs: this.dbQuery(auth, spec.q).docs };
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment();
    const send = o => { try { ws.send(JSON.stringify(o)); } catch {} };
    try {
      if (m.t === 'hello') {
        att.auth = await this.authFromToken(m.token);
        ws.serializeAttachment(att);
        send({ t: 'ready', uid: att.auth?.uid ?? null, admin: !!att.auth?.admin });
      } else if (m.t === 'sub') {
        const spec = m.doc ? { doc: m.doc } : { q: normQuery(m.q || {}) };
        if (spec.doc) parseDocPath(spec.doc);
        const res = this.runSpec(spec, att.auth);
        this.sql.exec('INSERT OR REPLACE INTO subs(sock, id, col, dpath, spec, hash) VALUES(?, ?, ?, ?, ?, ?)', att.sid, String(m.id), spec.q?.col ?? null, spec.doc ?? null, JSON.stringify(spec), fnv(JSON.stringify(res)));
        send({ t: 'snap', id: m.id, ...res });
      } else if (m.t === 'unsub') {
        this.sql.exec('DELETE FROM subs WHERE sock=? AND id=?', att.sid, String(m.id));
      } else if (m.t === 'get') {
        send({ t: 'res', id: m.id, ...this.dbGet(att.auth, m.path) });
      } else if (m.t === 'query') {
        send({ t: 'res', id: m.id, ...this.dbQuery(att.auth, m.q) });
      } else if (m.t === 'commit') {
        send({ t: 'ack', id: m.id, ...this.commit(att.auth, m.ops, m.batch) });
      }
    } catch (e) {
      send({ t: 'err', id: m.id ?? null, of: m.t, code: e.code || 'internal', message: e.message });
    }
  }

  webSocketClose(ws, code) {
    const { sid } = ws.deserializeAttachment() || {};
    if (sid) this.sql.exec('DELETE FROM subs WHERE sock=?', sid);
    try { ws.close(code === 1005 ? 1000 : code); } catch {}
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011); }

  broadcast(paths) {
    if (!paths.length) return;
    const cols = [...new Set(paths.map(p => parseDocPath(p).col))];
    const rows = this.sql.exec(`SELECT * FROM subs WHERE col IN (${cols.map(() => '?')}) OR dpath IN (${paths.map(() => '?')})`, ...cols, ...paths).toArray();
    if (!rows.length) return;
    const socks = new Map();
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a) socks.set(a.sid, { ws, a }); }
    for (const r of rows) {
      const s = socks.get(r.sock);
      if (!s) { this.sql.exec('DELETE FROM subs WHERE sock=?', r.sock); continue; }
      let res;
      try { res = this.runSpec(JSON.parse(r.spec), s.a.auth); }
      catch (e) { try { s.ws.send(JSON.stringify({ t: 'err', id: r.id, of: 'sub', code: e.code, message: e.message })); } catch {} continue; }
      const h = fnv(JSON.stringify(res));
      if (h === r.hash) continue;
      this.sql.exec('UPDATE subs SET hash=? WHERE sock=? AND id=?', h, r.sock, r.id);
      try { s.ws.send(JSON.stringify({ t: 'snap', id: r.id, ...res })); } catch {}
    }
  }

  // ---- blobs (content-addressed, chunked) ----
  async putBlob(buf, hash) {
    hash ??= await sha256hex(buf);
    if (this.sql.exec('SELECT 1 FROM blobmeta WHERE hash=?', hash).toArray().length) return hash;
    this.ctx.storage.transactionSync(() => {
      const bytes = new Uint8Array(buf);
      for (let n = 0, o = 0; o < bytes.length || n === 0; n++, o += CHUNK) this.sql.exec('INSERT INTO blobs(hash, n, data) VALUES(?, ?, ?)', hash, n, bytes.slice(o, o + CHUNK));
      this.sql.exec('INSERT INTO blobmeta(hash, size, created) VALUES(?, ?, ?)', hash, bytes.length, Date.now());
    });
    return hash;
  }
  readBlob(hash) {
    const parts = this.sql.exec('SELECT data FROM blobs WHERE hash=? ORDER BY n', hash).toArray().map(r => new Uint8Array(r.data));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  // Delete blobs nothing points at: the ones named, plus any orphan upload older than an hour.
  gc(hashes = []) {
    const old = this.sql.exec('SELECT hash FROM blobmeta WHERE created < ?', Date.now() - 3600e3).toArray().map(r => r.hash);
    for (const h of new Set([...hashes, ...old])) {
      if (!h) continue;
      const used = this.sql.exec('SELECT 1 FROM files WHERE hash=? UNION ALL SELECT 1 FROM site WHERE hash=? LIMIT 1', h, h).toArray().length;
      if (!used) { this.sql.exec('DELETE FROM blobs WHERE hash=?', h); this.sql.exec('DELETE FROM blobmeta WHERE hash=?', h); }
    }
  }

  // ---- storage ----
  fileRow(path) { return this.sql.exec('SELECT * FROM files WHERE path=?', path).toArray()[0]; }
  fileOut(r) {
    const enc = r.path.split('/').map(encodeURIComponent).join('/');
    return { path: r.path, name: r.path.split('/').pop(), size: r.size, type: r.type, owner: r.owner, created: r.created, updated: r.updated, url: `${this.origin}/__/storage/o/${enc}?t=${r.token}` };
  }
  fileInfo(r) { return r ? { path: r.path, name: r.path.split('/').pop(), size: r.size, type: r.type, owner: r.owner, created: r.created, updated: r.updated } : null; }
  checkFilePath(path) {
    if (!FILE_PATH.test(path) || path.split('/').some(s => s === '.' || s === '..')) throw err('invalid-argument', `Bad file path "${path}"`);
  }

  async filePut(req, auth, path) {
    this.checkFilePath(path);
    const max = Number(this.env.MAX_FILE_MB || 25) * 1048576;
    if (Number(req.headers.get('content-length') || 0) > max) throw err('payload-too-large', `Files must be under ${this.env.MAX_FILE_MB || 25} MB`);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > max) throw err('payload-too-large', `Files must be under ${this.env.MAX_FILE_MB || 25} MB`);
    const type = req.headers.get('content-type') || mimeOf(path);
    const old = this.fileRow(path);
    const incoming = { path, name: path.split('/').pop(), size: buf.byteLength, type };
    if (!this.can(auth, 'storage', path, old ? 'update' : 'create', this.fileInfo(old), incoming)) throw err('permission-denied', `Missing permission to upload ${path}`);
    if (this.sql.databaseSize + buf.byteLength > this.cap()) throw err('resource-exhausted', 'This project is out of storage space');
    const hash = await this.putBlob(buf);
    const now = Date.now();
    this.sql.exec('INSERT INTO files(path, size, type, token, owner, hash, created, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, type=excluded.type, hash=excluded.hash, owner=excluded.owner, updated=excluded.updated',
      path, buf.byteLength, type, old?.token || randomToken(16), auth?.uid ?? null, hash, now, now);
    if (old && old.hash !== hash) this.gc([old.hash]);
    return this.fileOut(this.fileRow(path));
  }

  fileGet(auth, path, t) {
    const r = this.fileRow(path);
    if (!(r && t && t === r.token) && !this.can(auth, 'storage', path, 'get', this.fileInfo(r), this.fileInfo(r))) throw err('permission-denied', `Missing permission to read ${path}`);
    if (!r) throw err('not-found', `No file at ${path}`);
    return new Response(this.readBlob(r.hash), { headers: { 'content-type': r.type, 'content-length': String(r.size), etag: `"${r.hash}"`, 'cache-control': 'private, max-age=3600' } });
  }

  fileMeta(auth, path) {
    const r = this.fileRow(path);
    if (!this.can(auth, 'storage', path, 'get', this.fileInfo(r), this.fileInfo(r))) throw err('permission-denied', `Missing permission to read ${path}`);
    if (!r) throw err('not-found', `No file at ${path}`);
    return this.fileOut(r);
  }

  fileList(auth, prefix) {
    const rows = this.sql.exec("SELECT * FROM files WHERE substr(path, 1, length(?)) = ? ORDER BY path LIMIT 1000", prefix, prefix).toArray();
    return { files: rows.filter(r => this.can(auth, 'storage', r.path, 'list', this.fileInfo(r), this.fileInfo(r))).map(r => this.fileOut(r)) };
  }

  fileDelete(auth, path) {
    const r = this.fileRow(path);
    if (!this.can(auth, 'storage', path, 'delete', this.fileInfo(r), null)) throw err('permission-denied', `Missing permission to delete ${path}`);
    if (!r) throw err('not-found', `No file at ${path}`);
    this.sql.exec('DELETE FROM files WHERE path=?', path);
    this.gc([r.hash]);
    return { ok: true };
  }

  // ---- hosting ----
  cleanSiteFiles(files) {
    if (!files || typeof files !== 'object') throw err('invalid-argument', 'Expected { files: { "/path": { hash, size, type } } }');
    const out = {};
    for (const [p, f] of Object.entries(files)) {
      const path = '/' + String(p).replace(/^\/+/, '');
      if (path.split('/').some(s => s === '..') || !/^[0-9a-f]{64}$/.test(f?.hash || '')) throw err('invalid-argument', `Bad site file ${p}`);
      out[path] = { hash: f.hash, size: Number(f.size) || 0, type: f.type || mimeOf(path) };
    }
    return out;
  }
  hostingPlan({ files }) {
    const clean = this.cleanSiteFiles(files);
    const hashes = [...new Set(Object.values(clean).map(f => f.hash))];
    return { missing: hashes.filter(h => !this.sql.exec('SELECT 1 FROM blobmeta WHERE hash=?', h).toArray().length) };
  }
  async hostingBlob(hash, buf) {
    if ((await sha256hex(buf)) !== hash) throw err('invalid-argument', 'File contents do not match their hash');
    if (buf.byteLength > Number(this.env.MAX_FILE_MB || 25) * 1048576) throw err('payload-too-large', 'File too large');
    if (this.sql.databaseSize + buf.byteLength > this.cap()) throw err('resource-exhausted', 'This project is out of storage space');
    await this.putBlob(buf, hash);
    return { ok: true };
  }
  hostingRelease({ files, config = {} }) {
    const clean = this.cleanSiteFiles(files);
    const missing = this.hostingPlan({ files: clean }).missing;
    if (missing.length) throw err('failed-precondition', `${missing.length} files were not uploaded yet`);
    const old = this.sql.exec('SELECT hash FROM site').toArray().map(r => r.hash);
    const prev = this.meta('hosting');
    const info = {
      version: (prev?.version || 0) + 1, at: Date.now(), files: Object.keys(clean).length,
      size: Object.values(clean).reduce((s, f) => s + f.size, 0),
      config: { spa: !!config.spa, cleanUrls: !!config.cleanUrls },
    };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM site');
      for (const [path, f] of Object.entries(clean)) this.sql.exec('INSERT INTO site(path, hash, type, size) VALUES(?, ?, ?, ?)', path, f.hash, f.type, f.size);
      this.setMeta('hosting', info);
    });
    this.gc(old);
    return { ...info, url: this.origin };
  }

  async serveSite(req, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const info = this.meta('hosting');
    if (!info) return this.page(200, `${this.pid} is ready`, `This is a new <b>Rennko Cloud</b> project. Deploy a site from the console or with <code>rennko deploy</code> and it shows up here.`);
    const cfg = info.config || {};
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { p = url.pathname; }
    const find = path => this.sql.exec('SELECT * FROM site WHERE path=?', path).toArray()[0];
    let row, status = 200;
    if (p.endsWith('/')) row = find(p + 'index.html');
    else {
      row = find(p) || (cfg.cleanUrls && find(p + '.html'));
      if (!row && find(p + '/index.html')) return new Response(null, { status: 301, headers: { location: p.split('/').pop() + '/' + url.search } });
    }
    if (!row && cfg.spa && !/\.[a-z0-9]+$/i.test(p)) row = find('/index.html');
    if (!row) { row = find('/404.html'); status = 404; }
    if (!row) return this.page(404, 'Page not found', `There's no page at <code>${esc(p)}</code>.`);
    const etag = `"${row.hash}"`;
    const headers = { 'content-type': row.type, etag, 'cache-control': 'public, max-age=0, must-revalidate' };
    if (status === 200 && req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(req.method === 'HEAD' ? null : this.readBlob(row.hash), { status, headers });
  }

  page(status, title, body) {
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#faf8f5;color:#222}main{max-width:32rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}code{background:#0001;padding:.1em .35em;border-radius:4px}a{color:#c2410c}@media(prefers-color-scheme:dark){body{background:#151413;color:#eee}code{background:#fff1}}</style>
<main><h1>${esc(title)}</h1><p>${body}</p><p><small>Powered by <a href="https://console.rennko.tech">Rennko Cloud</a></small></p></main>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ---- admin ----
  async adminRoute(r, m, url, body) {
    if (r === 'info' && m === 'GET') {
      return {
        id: this.pid, owner: this.meta('owner'), created: this.meta('created'), adminKey: this.meta('adminKey'),
        rules: this.rules(), settings: this.meta('settings') || {}, hosting: this.meta('hosting') || null, url: this.origin,
        usage: { bytes: this.sql.databaseSize, cap: this.cap(), users: this.count('users'), docs: this.count('docs'), files: this.count('files'), connections: this.ctx.getWebSockets().length },
      };
    }
    if (r === 'rules' && m === 'PUT') {
      const rules = await body();
      try { validateRules(rules); } catch (e) { throw err('invalid-argument', e.message); }
      this.setMeta('rules', { db: rules.db || {}, storage: rules.storage || {} });
      this._rules = null;
      return { ok: true };
    }
    if (r === 'settings' && m === 'PUT') {
      const b = await body();
      const s = { ...(this.meta('settings') || {}) };
      if ('googleClientId' in b) s.googleClientId = String(b.googleClientId || '').trim() || null;
      this.setMeta('settings', s);
      return s;
    }
    if (r === 'users' && m === 'GET') {
      const q = url.searchParams.get('q') || '';
      const rows = this.sql.exec("SELECT * FROM users WHERE (? = '' OR email LIKE ? OR uid = ?) ORDER BY created DESC LIMIT ? OFFSET ?", q, `%${q}%`, q, Number(url.searchParams.get('limit')) || 100, Number(url.searchParams.get('offset')) || 0).toArray();
      return { users: rows.map(u => ({ ...this.pubUser(u), last: u.last })), total: this.count('users') };
    }
    if (r.startsWith('users/') && m === 'DELETE') { this.deleteUser(r.slice(6)); return { ok: true }; }
    if (r === 'collections' && m === 'GET') return { collections: this.sql.exec('SELECT col AS name, COUNT(*) AS count FROM docs GROUP BY col ORDER BY col').toArray() };
    if (r === 'rotate-key' && m === 'POST') { const k = 'rk_' + randomToken(24); this.setMeta('adminKey', k); return { adminKey: k }; }
    if (r === 'wipe' && m === 'POST') {
      for (const ws of this.ctx.getWebSockets()) try { ws.close(1001, 'Project deleted'); } catch {}
      await this.ctx.storage.deleteAll();
      this._exists = false; this._pid = null; this._rules = null;
      return { ok: true };
    }
    throw err('not-found', `Unknown endpoint /__/admin/${r}`);
  }

  // ---- project registry (only in the "console" project) ----
  async registryRoute(r, url, body) {
    if (r === 'add') {
      const { id, owner } = await body();
      if (this.sql.exec('SELECT 1 FROM registry WHERE id=?', id).toArray().length) throw err('already-exists', `The name "${id}" is taken`);
      this.sql.exec('INSERT INTO registry(id, owner, created) VALUES(?, ?, ?)', id, owner, Date.now());
      return { ok: true };
    }
    if (r === 'list') return { projects: this.sql.exec('SELECT * FROM registry WHERE owner=? ORDER BY created', url.searchParams.get('owner')).toArray() };
    if (r === 'get') return { project: this.sql.exec('SELECT * FROM registry WHERE id=?', url.searchParams.get('id')).toArray()[0] || null };
    if (r === 'remove') { const { id } = await body(); this.sql.exec('DELETE FROM registry WHERE id=?', id); return { ok: true }; }
    throw err('not-found', 'Unknown registry call');
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
