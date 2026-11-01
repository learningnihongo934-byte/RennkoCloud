#!/usr/bin/env node
// rennko: command line for Rennko Cloud (Node 18+, no dependencies).
//   rennko login [--host URL]            sign in to the console (default https://console.rennko.tech)
//   rennko logout
//   rennko projects                      list your projects
//   rennko create <id>                   make a project at <id>.rennko.tech
//   rennko deploy [--project id] [--dir public] [--spa] [--clean-urls] [--rules rules.json]
// deploy also reads rennko.json ({ "project", "dir", "spa", "cleanUrls", "rules" }) from the current folder.
// In CI, set RENNKO_ADMIN_KEY (from the console's Overview tab) instead of logging in.
import { readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, sep, extname } from 'node:path';
import { createInterface } from 'node:readline';

const CRED = join(process.env.RENNKO_HOME || join(homedir(), '.rennko'), 'credentials.json');
const DEFAULT_HOST = 'https://console.rennko.tech';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.pdf': 'application/pdf' };

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, isBool) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return undefined;
  if (isBool) { args.splice(i, 1); return true; }
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const die = m => { console.error('✗ ' + m); process.exit(1); };
const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
const loadCred = () => readJson(CRED).catch(() => null);
const saveCred = async c => { await mkdir(join(CRED, '..'), { recursive: true }); await writeFile(CRED, JSON.stringify(c, null, 2), { mode: 0o600 }); };

async function api(url, { method = 'GET', body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(url, { method, headers: h, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `${r.status} ${r.statusText}`);
  return data;
}

function ask(q, hidden) {
  return new Promise(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); });
  });
}

// A fresh console token from the saved refresh token
async function session() {
  const c = await loadCred();
  if (!c) die('Not signed in. Run: rennko login');
  const s = await api(c.host + '/__/auth/refresh', { method: 'POST', body: { refreshToken: c.refreshToken } }).catch(e => die(`Session expired (${e.message}). Run: rennko login`));
  return { host: c.host, auth: { authorization: 'Bearer ' + s.token } };
}

async function projectHeaders(id) {
  if (process.env.RENNKO_ADMIN_KEY) {
    const host = process.env.RENNKO_HOST || DEFAULT_HOST;
    return { url: process.env.RENNKO_PROJECT_URL || projectUrlFor(host, id), headers: { 'x-admin-key': process.env.RENNKO_ADMIN_KEY } };
  }
  const { host, auth } = await session();
  const { projects } = await api(host + '/v1/projects', { headers: auth });
  const p = projects.find(x => x.id === id);
  if (!p) die(`You don't have a project called "${id}". Make it with: rennko create ${id}`);
  return { url: p.url, headers: auth };
}
function projectUrlFor(host, id) {
  const u = new URL(host);
  return u.hostname.startsWith('console.') ? `${u.protocol}//${id}.${u.hostname.slice(8)}` : `${u.origin}/p/${id}`;
}

async function walk(dir, root = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, root, out);
    else if (e.isFile()) out.push({ abs: p, path: '/' + relative(root, p).split(sep).join('/') });
  }
  return out;
}

const commands = {
  async login() {
    const host = (flag('host') || process.env.RENNKO_HOST || DEFAULT_HOST).replace(/\/+$/, '');
    const email = flag('email') || process.env.RENNKO_EMAIL || await ask('Email: ');
    const password = flag('password') || process.env.RENNKO_PASSWORD || await ask('Password: ', true);
    const s = await api(host + '/__/auth/signin', { method: 'POST', body: { email, password } }).catch(e => die(e.message));
    await saveCred({ host, email: s.user.email, refreshToken: s.refreshToken });
    console.log(`✓ Signed in to ${host} as ${s.user.email}`);
  },
  async logout() {
    await rm(CRED, { force: true });
    console.log('✓ Signed out');
  },
  async projects() {
    const { host, auth } = await session();
    const { projects } = await api(host + '/v1/projects', { headers: auth });
    if (!projects.length) console.log('No projects yet. Make one with: rennko create <name>');
    for (const p of projects) console.log(`${p.id.padEnd(24)} ${p.url}`);
  },
  async create() {
    const id = args[0] || die('Usage: rennko create <id>');
    const { host, auth } = await session();
    const p = await api(host + '/v1/projects', { method: 'POST', body: { id }, headers: auth }).catch(e => die(e.message));
    console.log(`✓ Created ${p.id}: ${p.url}`);
  },
  async deploy() {
    const cfg = await readJson('rennko.json').catch(() => ({}));
    const id = flag('project') || cfg.project || die('Which project? Pass --project <id> or add "project" to rennko.json');
    const dir = flag('dir') || cfg.dir || 'public';
    const spa = flag('spa', true) || !!cfg.spa;
    const cleanUrls = flag('clean-urls', true) || !!cfg.cleanUrls;
    const rulesFile = flag('rules') || cfg.rules;
    const { url, headers } = await projectHeaders(id);
    const call = (path, o = {}) => api(url + '/__/' + path, { ...o, headers: { ...headers, ...o.headers } });

    if (rulesFile) {
      await call('admin/rules', { method: 'PUT', body: await readJson(rulesFile) }).catch(e => die(`Rules: ${e.message}`));
      console.log(`✓ Rules published from ${rulesFile}`);
    }
    if (!(await stat(dir).catch(() => null))?.isDirectory()) { if (rulesFile) return; die(`No folder "${dir}" to deploy`); }
    const files = await walk(dir);
    if (!files.some(f => f.path === '/index.html')) console.warn(`! No index.html in ${dir}`);
    const manifest = {};
    for (const f of files) {
      f.buf = await readFile(f.abs);
      f.hash = createHash('sha256').update(f.buf).digest('hex');
      manifest[f.path] = { hash: f.hash, size: f.buf.length, type: MIME[extname(f.path).toLowerCase()] };
    }
    const { missing } = await call('hosting/plan', { method: 'POST', body: { files: manifest } });
    console.log(`Deploying ${files.length} files from ${dir} (${missing.length} new or changed)`);
    const todo = files.filter((f, i, a) => missing.includes(f.hash) && a.findIndex(x => x.hash === f.hash) === i);
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (todo.length) {
        const f = todo.shift();
        await call('hosting/blob/' + f.hash, { method: 'PUT', body: f.buf, raw: true, headers: { 'content-type': 'application/octet-stream' } });
        console.log(`  ↑ ${f.path}`);
      }
    }));
    const r = await call('hosting/release', { method: 'POST', body: { files: manifest, config: { spa, cleanUrls } } });
    console.log(`✓ Live: ${r.url} (version ${r.version})`);
  },
};

if (!commands[cmd]) {
  console.log('Rennko Cloud CLI\n\n  rennko login [--host URL]\n  rennko logout\n  rennko projects\n  rennko create <id>\n  rennko deploy [--project id] [--dir public] [--spa] [--clean-urls] [--rules rules.json]\n');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch(e => die(e.message));
