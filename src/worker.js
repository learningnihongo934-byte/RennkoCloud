// Rennko Cloud front door. Routes:
//   <id>.rennko.tech/...        project <id>: hosted site, and its API under /__/
//   <host>/p/<id>/...           same, by path (local dev, workers.dev)
//   console.rennko.tech/        the dashboard (static files in public/), its own auth at /__/
//   console.rennko.tech/v1/...  platform API: create, list and delete projects
import { Project } from './project.js';
import { verifyToken } from './crypto.js';

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

async function toProject(req, env, ctx, id, path, origin) {
  if (id !== 'console' && !ID.test(id)) return new Response('Not found', { status: 404 });
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
    if (hit) return hit;
  }

  const headers = new Headers(req.headers);
  for (const k of [...headers.keys()]) if (k.startsWith('x-rk-')) headers.delete(k);
  headers.set('x-rk-project', id);
  headers.set('x-rk-origin', origin);
  const target = new URL(path + new URL(req.url).search, 'https://project');
  let res = await stub(env, id).fetch(new Request(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? null : req.body, redirect: 'manual' }));
  if (res.status === 101) return res;
  if (api) return withCors(res);
  if (cacheKey && res.status === 200) {
    res = new Response(res.body, res);
    res.headers.set('cache-control', `public, max-age=${ttl}`);
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  }
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

function projectUrl(env, url, id) {
  const base = env.BASE_DOMAIN;
  if (base && (url.hostname === base || url.hostname.endsWith(`.${base}`))) return `https://${id}.${base}`;
  return `${url.origin}/p/${id}`;
}
