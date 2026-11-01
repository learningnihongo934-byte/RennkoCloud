// Rennko Cloud front door. Routes:
//   <id>.rennko.tech/...        project <id>: hosted site, and its API under /__/
//   <host>/p/<id>/...           same, by path (local dev, workers.dev)
//   console.rennko.tech/        the dashboard (static files in public/), its own auth at /__/
//   console.rennko.tech/v1/...  platform API: create, list and delete projects
//   cloud.rennko.tech/          the Rennko Cloud website (public/site/, or /site/ on other hosts)
import { Project } from './project.js';
import { verifyToken } from './crypto.js';
import { screen } from './pages.js';

export { Project };

const ID = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set(('www console api app apps admin auth login signin signup account dashboard docs doc help support status blog news mail email smtp imap pop ' +
  'ftp cdn static assets files storage dev test staging prod beta h p rennko cloud firebase ns ns1 ns2 mx zoho webmail autodiscover').split(' '));
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-admin-key',
  'access-control-max-age': '86400',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const fail = (code, message, status) => json({ error: { code, message } }, status);
const stub = (env, id) => env.PROJECT.get(env.PROJECT.idFromName(id));

export default {
  async fetch(req, env, ctx) {
    if (!env.SECRET) return new Response('Rennko Cloud needs a SECRET (./build.sh sets one up).', { status: 500 });
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const base = env.BASE_DOMAIN;
    const host = url.hostname;
    if (base && host === `www.${base}`) return Response.redirect(`https://${base}${url.pathname}${url.search}`, 301);
    const sub = base && host.endsWith(`.${base}`) ? host.slice(0, -base.length - 1) : host.endsWith('.localhost') ? host.slice(0, -10) : null;

    if (url.pathname === '/v1/discover' && req.method === 'GET') return discover(env, ctx, url);
    if (sub === 'cloud') return site(req, env, url);
    if (sub && sub !== 'console') return toProject(req, env, ctx, sub, url.pathname, url.origin);
    const m = url.pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (m) {
      if (!m[2]) return Response.redirect(`${url.origin}/p/${m[1]}/${url.search}`, 301);
      return toProject(req, env, ctx, m[1], m[2], `${url.origin}/p/${m[1]}`);
    }
    if (url.pathname.startsWith('/__/')) return toProject(req, env, ctx, 'console', url.pathname, url.origin);
    if (url.pathname.startsWith('/v1/')) {
      try { return await platform(req, env, url); }
      catch (e) { console.error(e); return fail('internal', e.message, 500); }
    }
    return withCors(await env.ASSETS.fetch(req));
  },
};

function withCors(res) {
  res = new Response(res.body, res);
  for (const k in CORS) res.headers.set(k, CORS[k]);
  return res;
}

// Where the console and the website live, as seen from this request
function links(env, url) {
  const base = env.BASE_DOMAIN;
  const onBase = base && (url.hostname === base || url.hostname.endsWith(`.${base}`));
  return { consoleUrl: onBase ? `https://console.${base}` : url.origin, siteUrl: onBase ? `https://cloud.${base}/` : `${url.origin}/site/` };
}

async function site(req, env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/site' + url.pathname + url.search, url), req));
  const loc = res.headers.get('location');
  if (loc?.startsWith('/site/')) return new Response(null, { status: res.status, headers: { location: loc.slice(5) } });
  return res;
}

async function toProject(req, env, ctx, id, path, origin) {
  const url = new URL(req.url);
  const { consoleUrl, siteUrl } = links(env, url);
  if (id !== 'console' && (!ID.test(id) || id.includes('--') || RESERVED.has(id))) {
    if (path.startsWith('/__/')) return fail('not-found', `No project "${id}"`, 404);
    return screen({ kind: RESERVED.has(id) ? 'reserved' : 'invalid', name: id, url: origin, home: origin + '/', consoleUrl, siteUrl });
  }
  // The SDK is served from every project too, so apps can import '/__/rennko.js'
  if (path === '/__/rennko.js' || path === '/__/rennko-core.js') return withCors(await env.ASSETS.fetch(new Request(new URL(path.slice(3), req.url))));
  if (path === '/__/init.js') {
    return new Response(`export * from './rennko.js';\nimport { initApp } from './rennko.js';\nexport const app = initApp({ url: ${JSON.stringify(origin)} });\n`,
      { headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=300', ...CORS } });
  }

  const api = path.startsWith('/__/');
  const ttl = Number(env.HOSTING_CACHE || 0);
  const cacheKey = !api && req.method === 'GET' && ttl > 0 ? new Request(req.url) : null;
  if (cacheKey) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return counted(req, env, ctx, id, origin, hit);
  }

  const headers = new Headers(req.headers);
  for (const k of [...headers.keys()]) if (k.startsWith('x-rk-')) headers.delete(k);
  headers.set('x-rk-project', id);
  headers.set('x-rk-origin', origin);
  headers.set('x-rk-console', consoleUrl);
  headers.set('x-rk-site', siteUrl);
  const target = new URL(path + new URL(req.url).search, 'https://project');
  let res = await stub(env, id).fetch(new Request(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? null : req.body, redirect: 'manual' }));
  if (res.status === 101) return res;
  if (api) return withCors(res);
  if (cacheKey && res.status === 200) {
    res = new Response(res.body, res);
    res.headers.set('cache-control', `public, max-age=${ttl}`);
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  }
  return counted(req, env, ctx, id, origin, res);
}

// ---- visits, for Discover ----
// A visit is the first page of a hosted site someone loads in a day (a cookie on the site
// remembers the day). Counts pile up in memory and go to the console project in one batch,
// at most VISIT_FLUSH_MS (10 s) after the first visit in the batch.
const today = () => new Date().toISOString().slice(0, 10);
const BOT = /bot|crawl|spider|slurp|preview|curl|wget|python|headless|monitor|lighthouse|facebookexternalhit/i;
let pending = new Map(), flushScheduled = false;

function flushVisits(env) {
  flushScheduled = false;
  const rows = [...pending].map(([k, n]) => [...k.split('|'), n]);
  pending = new Map();
  if (!rows.length) return;
  return stub(env, 'console').fetch(new Request('https://project/__/registry/visits', {
    method: 'POST', headers: { 'x-rk-project': 'console', 'x-rk-internal': '1', 'content-type': 'application/json' }, body: JSON.stringify({ rows }),
  })).catch(() => {});
}

function counted(req, env, ctx, id, origin, res) {
  if (id === 'console' || req.method !== 'GET' || res.status !== 200 || !res.headers.get('etag') || !(res.headers.get('content-type') || '').startsWith('text/html')) return res;
  if (BOT.test(req.headers.get('user-agent') || '')) return res;
  const day = today();
  if ((req.headers.get('cookie') || '').includes(`rk_seen=${day}`)) return res;
  pending.set(`${day}|${id}`, (pending.get(`${day}|${id}`) || 0) + 1);
  const wait = Number(env.VISIT_FLUSH_MS ?? 10000);
  if (pending.size > 50 || wait <= 0) ctx.waitUntil(flushVisits(env));
  else if (!flushScheduled) {
    flushScheduled = true;
    ctx.waitUntil(new Promise(r => setTimeout(r, wait)).then(() => flushVisits(env)));
  }
  res = new Response(res.body, res);
  const path = new URL(origin).pathname.replace(/\/?$/, '/');
  res.headers.append('set-cookie', `rk_seen=${day}; Path=${path}; Max-Age=172800; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`);
  return res;
}

// Public list of sites for the Discover page, most visited today first
async function discover(env, ctx, url) {
  const ttl = Math.min(30, Number(env.HOSTING_CACHE || 0));
  const key = new Request(url.origin + '/v1/discover');
  if (ttl) { const hit = await caches.default.match(key); if (hit) return hit; }
  const day = today();
  const r = await stub(env, 'console').fetch(new Request(`https://project/__/registry/discover?day=${day}`, { headers: { 'x-rk-project': 'console', 'x-rk-internal': '1' } }));
  const { sites } = await r.json();
  const list = sites.map(s => {
    const site = projectUrl(env, url, s.id);
    let image = null;
    try { if (s.image) { const u = /^\/(?!\/)/.test(s.image) ? new URL(site + s.image) : new URL(s.image, site + '/'); if (/^https?:$/.test(u.protocol)) image = u.href; } } catch {}
    return { id: s.id, url: site, title: s.title || s.id, description: s.description || '', image, today: s.today, total: s.total, updated: s.updated };
  });
  const res = json({ day, sites: list, top: list.slice(0, 5) });
  if (ttl) { res.headers.set('cache-control', `public, max-age=${ttl}`); ctx.waitUntil(caches.default.put(key, res.clone())); }
  return res;
}

// Platform API, signed in as a console user
async function platform(req, env, url) {
  const h = req.headers.get('authorization') || '';
  const claims = h.startsWith('Bearer ') ? await verifyToken(env.SECRET, h.slice(7)) : null;
  if (!claims || claims.p !== 'console' || claims.anon) return fail('unauthenticated', 'Sign in to the Rennko Cloud console first', 401);
  const uid = claims.uid;

  const call = async (id, route, method = 'POST', body) => {
    const r = await stub(env, id).fetch(new Request(`https://project/__/${route}`, {
      method,
      headers: { 'x-rk-project': id, 'x-rk-internal': '1', 'x-rk-origin': projectUrl(env, url, id), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : null,
    }));
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error?.message || 'Request failed'), { status: r.status, code: data.error?.code });
    return data;
  };
  const guard = async fn => { try { return await fn(); } catch (e) { if (e.status) return fail(e.code, e.message, e.status); throw e; } };
  const out = p => ({ id: p.id, created: p.created, url: projectUrl(env, url, p.id) });

  if (url.pathname === '/v1/projects' && req.method === 'GET') {
    return guard(async () => json({ projects: (await call('console', `registry/list?owner=${encodeURIComponent(uid)}`, 'GET')).projects.map(out) }));
  }
  if (url.pathname === '/v1/projects' && req.method === 'POST') {
    const { id } = await req.json().catch(() => ({}));
    if (!ID.test(id || '') || id.includes('--')) return fail('invalid-argument', 'Project IDs are 3 to 30 lowercase letters, numbers and single hyphens, starting with a letter', 400);
    if (RESERVED.has(id)) return fail('already-exists', `"${id}" is reserved, pick another name`, 409);
    return guard(async () => {
      const mine = (await call('console', `registry/list?owner=${encodeURIComponent(uid)}`, 'GET')).projects;
      const max = Number(env.MAX_PROJECTS || 5);
      if (mine.length >= max) return fail('resource-exhausted', `Free accounts can have ${max} projects. Delete one to make room.`, 429);
      await call('console', 'registry/add', 'POST', { id, owner: uid });
      try { await call(id, 'admin/init', 'POST', { owner: uid }); }
      catch (e) { await call('console', 'registry/remove', 'POST', { id }); throw e; }
      return json(out({ id, created: Date.now() }), 201);
    });
  }
  if (url.pathname.startsWith('/v1/admin/')) {
    if (claims.sa !== true) return fail('permission-denied', 'Only Rennko Cloud admins can do this', 403);
    return guard(() => admin(url.pathname.slice(10), req, call, out));
  }
  const del = url.pathname.match(/^\/v1\/projects\/([a-z0-9-]+)$/);
  if (del && req.method === 'DELETE') {
    return guard(async () => {
      const { project } = await call('console', `registry/get?id=${del[1]}`, 'GET');
      if (!project || project.owner !== uid) return fail('not-found', 'No such project', 404);
      await call(del[1], 'admin/wipe');
      await call('console', 'registry/remove', 'POST', { id: del[1] });
      return json({ ok: true });
    });
  }
  return fail('not-found', 'Unknown endpoint', 404);
}

// Rennko Cloud admin API (console accounts listed in ADMIN_EMAILS)
async function admin(path, req, call, out) {
  const body = () => req.json().catch(() => ({}));
  if (path === 'overview' && req.method === 'GET') {
    const [{ projects }, { users }, { names }] = await Promise.all([call('console', `registry/all?day=${today()}`, 'GET'), call('console', 'registry/users', 'GET'), call('console', 'registry/blocked', 'GET')]);
    // Live numbers from each project (capped so one page load stays cheap)
    const stats = await Promise.all(projects.slice(0, 200).map(p => call(p.id, 'admin/info', 'GET').catch(() => null)));
    const list = projects.map((p, i) => ({
      ...out(p), owner: p.owner, ownerEmail: p.ownerEmail, ownerDisabled: !!p.ownerDisabled, visitsToday: p.visitsToday || 0,
      usage: stats[i]?.usage || null, site: stats[i]?.hosting ? { version: stats[i].hosting.version, files: stats[i].hosting.files, at: stats[i].hosting.at } : null,
      suspended: stats[i]?.suspended || null,
    }));
    const sum = k => list.reduce((s, p) => s + (p.usage?.[k] || 0), 0);
    return json({ projects: list, users, blockedNames: names, totals: { projects: list.length, developers: users.length, bytes: sum('bytes'), appUsers: sum('users'), visitsToday: list.reduce((s, p) => s + p.visitsToday, 0), docs: sum('docs'), files: sum('files'), connections: sum('connections') } });
  }
  let m = path.match(/^projects\/([a-z0-9-]+)\/(suspend|unsuspend)$/);
  if (m && req.method === 'POST') { await call(m[1], `admin/${m[2]}`, 'POST', await body()); return json({ ok: true }); }
  m = path.match(/^projects\/([a-z0-9-]+)$/);
  if (m && req.method === 'DELETE') {
    await call(m[1], 'admin/wipe');
    await call('console', 'registry/remove', 'POST', { id: m[1] });
    return json({ ok: true });
  }
  m = path.match(/^users\/([\w-]+)\/ban$/);
  if (m && req.method === 'POST') {
    const { disabled = true, suspendProjects = false } = await body();
    const r = await call('console', 'registry/ban', 'POST', { uid: m[1], disabled: !!disabled });
    // Banning can suspend their projects; unbanning brings back only the ones the ban suspended
    if (suspendProjects || !disabled) for (const id of r.projects) await call(id, `admin/${disabled ? 'suspend' : 'unsuspend'}`, 'POST', disabled ? { reason: 'Owner banned' } : { onlyIf: 'Owner banned' }).catch(() => {});
    return json({ ok: true, projects: r.projects });
  }
  m = path.match(/^users\/([\w-]+)$/);
  if (m && req.method === 'DELETE') {
    const { projects } = await call('console', `registry/list?owner=${encodeURIComponent(m[1])}`, 'GET');
    await call('console', 'registry/delete-user', 'POST', { uid: m[1] });
    for (const p of projects) { await call(p.id, 'admin/wipe').catch(() => {}); await call('console', 'registry/remove', 'POST', { id: p.id }); }
    return json({ ok: true, deletedProjects: projects.map(p => p.id) });
  }
  if (path === 'blocked-names' && req.method === 'PUT') return json(await call('console', 'registry/blocked?set=1', 'POST', await body()));
  return fail('not-found', 'Unknown admin endpoint', 404);
}

function projectUrl(env, url, id) {
  const base = env.BASE_DOMAIN;
  if (base && (url.hostname === base || url.hostname.endsWith(`.${base}`))) return `https://${id}.${base}`;
  return `${url.origin}/p/${id}`;
}
