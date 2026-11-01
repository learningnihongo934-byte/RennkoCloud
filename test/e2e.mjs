// End-to-end test against a running server: RENNKO_URL=http://localhost:8799 node test/e2e.mjs
// (./build.sh test starts one for you.)
import { initApp, memoryStore, serverTimestamp, increment, arrayUnion } from '../public/rennko.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.RENNKO_URL || 'http://localhost:8787').replace(/\/$/, '');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await Promise.race([fn(), sleep(20000).then(() => { throw new Error('test timed out'); })]); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m = 'expected truthy') => { if (!v) throw new Error(m); };
const rejects = async (p, code) => {
  try { await p; } catch (e) { if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`); return e; }
  throw new Error(`expected a ${code || ''} rejection`);
};
const waitFor = async (fn, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40); }
  throw new Error('timed out waiting for ' + what);
};
const req = async (path, { method, body, token, headers = {} } = {}) => {
  const r = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), redirect: 'manual', headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: 'Bearer ' + token }), ...headers }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch { d = text; }
  return { status: r.status, d, r };
};

const stamp = Date.now().toString(36);
const P = 'demo' + stamp;
const dev1 = initApp({ url: BASE, storage: memoryStore() });
const dev2 = initApp({ url: BASE, storage: memoryStore() });
let tok1, url, adminKey, alice, aliceUid, bob, bobUid;
const apps = [dev1, dev2];
const open = (o = {}) => { const a = initApp({ url, storage: memoryStore(o.map), ...o }); apps.push(a); return a; };

console.log(`Rennko Cloud e2e against ${BASE}`);

await t('console page and SDK are served', async () => {
  const home = await req('/');
  ok(home.status === 200 && String(home.d).includes('Rennko Cloud'), 'console html');
  const sdk = await fetch(BASE + '/rennko.js');
  eq(sdk.status, 200);
  eq(sdk.headers.get('access-control-allow-origin'), '*', 'cors');
});

await t('developer accounts', async () => {
  await dev1.auth.signUp(`dev1-${stamp}@test.dev`, 'password1');
  await dev2.auth.signUp(`dev2-${stamp}@test.dev`, 'password2');
  tok1 = await dev1.auth.getToken();
  ok(tok1 && dev1.auth.currentUser.email.startsWith('dev1'));
  eq((await req('/v1/projects')).status, 401, 'needs sign-in');
});

await t('create and list projects', async () => {
  const c = await req('/v1/projects', { body: { id: P }, token: tok1 });
  eq(c.status, 201, JSON.stringify(c.d));
  url = c.d.url;
  eq(url, `${BASE}/p/${P}`);
  eq((await req('/v1/projects', { body: { id: P }, token: tok1 })).status, 409, 'duplicate');
  eq((await req('/v1/projects', { body: { id: 'console' }, token: tok1 })).status, 409, 'reserved');
  eq((await req('/v1/projects', { body: { id: 'Bad_Name' }, token: tok1 })).status, 400, 'invalid');
  const l = await req('/v1/projects', { token: tok1 });
  ok(l.d.projects.some(p => p.id === P), 'listed');
  const l2 = await req('/v1/projects', { token: await dev2.auth.getToken() });
  ok(!l2.d.projects.some(p => p.id === P), 'not listed for others');
});

await t('only the owner gets admin access', async () => {
  const info = await req(`/p/${P}/__/admin/info`, { token: tok1 });
  eq(info.status, 200);
  adminKey = info.d.adminKey;
  ok(adminKey.startsWith('rk_'));
  eq((await req(`/p/${P}/__/admin/info`, { token: await dev2.auth.getToken() })).status, 403, 'other dev');
  eq((await req(`/p/${P}/__/admin/info`, { headers: { 'x-admin-key': adminKey } })).status, 200, 'admin key');
  eq((await req(`/p/${P}/__/admin/info`, { headers: { 'x-admin-key': 'rk_wrong' } })).status, 403, 'wrong key');
  eq((await req(`/p/${P}/__/admin/info`)).status, 403, 'anonymous');
});

await t('auth: sign up, sign in, anonymous, errors', async () => {
  alice = open();
  bob = open();
  await alice.auth.signUp(`alice-${stamp}@test.dev`, 'secret1', 'Alice');
  aliceUid = alice.auth.currentUser.uid;
  eq(alice.auth.currentUser.name, 'Alice');
  await rejects(open().auth.signUp(`alice-${stamp}@test.dev`, 'secret1'), 'already-exists');
  await rejects(open().auth.signIn(`alice-${stamp}@test.dev`, 'nope!!'), 'unauthenticated');
  await rejects(open().auth.signUp('not-an-email', 'secret1'), 'invalid-argument');
  const again = open();
  await again.auth.signIn(`alice-${stamp}@test.dev`, 'secret1');
  eq(again.auth.currentUser.uid, aliceUid);
  await bob.auth.signInAnonymously();
  bobUid = bob.auth.currentUser.uid;
  ok(bob.auth.currentUser.anon);
  await rejects(open().auth.signInWithGoogle('x.y.z'), 'failed-precondition');
});

await t('database: set, get, update with field values, delete', async () => {
  const ref = alice.db.doc('todos/t1');
  await ref.set({ text: 'one', owner: aliceUid, n: 1, tags: ['a'], at: serverTimestamp() });
  let s = await ref.get();
  ok(s.exists && !s.metadata.fromCache);
  eq(s.data().text, 'one');
  ok(typeof s.data().at === 'number' && Math.abs(s.data().at - Date.now()) < 60000, 'server timestamp');
  await ref.update({ n: increment(5), tags: arrayUnion('b', 'a'), 'meta.seen': true });
  s = await ref.get();
  eq([s.data().n, s.data().tags, s.data().meta], [6, ['a', 'b'], { seen: true }]);
  await ref.set({ extra: 1 }, { merge: true });
  eq((await ref.get()).data().extra, 1);
  await rejects(alice.db.doc('todos/missing').update({ x: 1 }), 'not-found');
  await alice.db.doc('todos/gone').set({ owner: aliceUid });
  await alice.db.doc('todos/gone').delete();
  eq((await alice.db.doc('todos/gone').get()).exists, false);
});

await t('queries: where, orderBy, limit, in, array-contains', async () => {
  const col = alice.db.collection('items');
  const b = alice.db.batch();
  [['a', 5, 'red', ['x']], ['b', 2, 'blue', ['y']], ['c', 9, 'red', ['x', 'y']], ['d', 7, 'green', []], ['e', 1, 'red', ['z']]]
    .forEach(([id, n, color, tags]) => b.set(col.doc(id), { n, color, tags, owner: aliceUid }));
  await b.commit();
  const ids = async q => (await q.get()).docs.map(d => d.id);
  eq(await ids(col.where('color', '==', 'red').orderBy('n')), ['e', 'a', 'c']);
  eq(await ids(col.orderBy('n', 'desc').limit(2)), ['c', 'd']);
  eq(await ids(col.where('n', '>', 4).orderBy('n')), ['a', 'd', 'c']);
  eq(await ids(col.where('color', 'in', ['blue', 'green'])), ['b', 'd']);
  eq(await ids(col.where('tags', 'array-contains', 'y')), ['b', 'c']);
  eq(await ids(col.where('color', '!=', 'red')), ['b', 'd']);
  eq(await ids(col.where('__id', '>=', 'c').limit(2)), ['c', 'd']);
  eq(await ids(col.orderBy('n').limit(2).offset(1)), ['b', 'a']);
  // the SDK's offline query engine agrees with the server
  eq(await ids(col.where('color', '==', 'red').orderBy('n')), (await col.where('color', '==', 'red').orderBy('n').get({ source: 'cache' })).docs.map(d => d.id));
});

await t('security rules are enforced', async () => {
  const rules = {
    db: {
      'todos/{id}': { read: 'doc.owner == auth.uid', create: 'data.owner == auth.uid', update: 'doc.owner == auth.uid && data.owner == doc.owner', delete: 'doc.owner == auth.uid' },
      'items/{id}': { read: 'auth != null', write: 'data.owner == auth.uid || doc.owner == auth.uid' },
      'chat/{id}': { read: 'auth != null', write: 'auth != null && data.text.size() <= 100' },
      'notes/{id}': { read: 'auth != null', write: 'auth != null' },
      'users/{uid}/**': { read: 'auth.uid == uid', write: 'auth.uid == uid' },
    },
    storage: { 'avatars/{uid}/**': { read: 'true', write: "auth.uid == uid && data.size < 1000", delete: 'auth.uid == uid' } },
  };
  eq((await req(`/p/${P}/__/admin/rules`, { method: 'PUT', body: rules, token: tok1 })).status, 200);
  eq((await req(`/p/${P}/__/admin/rules`, { method: 'PUT', body: { db: { x: { read: 'auth ==' } } }, token: tok1 })).status, 400, 'bad rules rejected');
  await rejects(bob.db.doc('todos/t1').get(), 'permission-denied');
  eq((await bob.db.collection('todos').get()).size, 0, 'query filtered');
  eq((await alice.db.collection('todos').get()).size, 1);
  await rejects(bob.db.doc('todos/hack').set({ owner: aliceUid }), 'permission-denied');
  await rejects(bob.db.doc('todos/t1').delete(), 'permission-denied');
  await rejects(bob.db.doc('chat/long').set({ text: 'x'.repeat(101) }), 'permission-denied');
  await bob.db.doc(`users/${bobUid}/notes/n1`).set({ hi: 1 });
  await rejects(alice.db.doc(`users/${bobUid}/notes/n1`).get(), 'permission-denied');
  await rejects(open().db.doc('items/a').get({ source: 'server' }), 'permission-denied');
});

await t('realtime: listeners get changes from other users', async () => {
  const seen = [];
  const unsub = bob.db.collection('chat').orderBy('at').onSnapshot(s => seen.push(s));
  await waitFor(() => seen.some(s => !s.metadata.fromCache), 5000, 'first server snapshot');
  await alice.db.collection('chat').add({ text: 'hey bob', at: serverTimestamp() });
  const got = await waitFor(() => seen.find(s => s.docs.some(d => d.data().text === 'hey bob')), 5000, 'live update');
  ok(got.docChanges().some(c => c.type === 'added' && c.doc.data().text === 'hey bob'), 'docChanges');
  const docSeen = [];
  const unsub2 = bob.db.doc('chat/fixed').onSnapshot(s => docSeen.push(s.exists ? s.data().text : null));
  await alice.db.doc('chat/fixed').set({ text: 'v1', at: 1 });
  await waitFor(() => docSeen.includes('v1'), 5000, 'doc listener v1');
  await alice.db.doc('chat/fixed').update({ text: 'v2' });
  await waitFor(() => docSeen.includes('v2'), 5000, 'doc listener v2');
  await alice.db.doc('chat/fixed').delete();
  await waitFor(() => docSeen[docSeen.length - 1] === null, 5000, 'doc listener delete');
  unsub(); unsub2();
});

await t('offline: writes apply locally, queue, and sync on reconnect', async () => {
  const seen = [];
  alice.db.collection('notes').onSnapshot(s => seen.push(s));
  await waitFor(() => alice.online, 5000, 'alice online');
  await alice.disableNetwork();
  ok(!alice.online);
  const p = alice.db.doc('notes/offline1').set({ text: 'written offline' });
  const snap = await waitFor(() => seen.find(s => s.docs.some(d => d.id === 'offline1')), 2000, 'local snapshot');
  ok(snap.metadata.hasPendingWrites && snap.metadata.fromCache, 'pending + fromCache');
  eq((await alice.db.doc('notes/offline1').get()).data().text, 'written offline', 'offline get');
  eq((await bob.db.doc('notes/offline1').get()).exists, false, 'not on server yet');
  await alice.enableNetwork();
  await p;
  eq((await bob.db.doc('notes/offline1').get()).data().text, 'written offline', 'synced');
  await waitFor(() => { const s = seen[seen.length - 1]; return s && !s.metadata.hasPendingWrites && !s.metadata.fromCache; }, 5000, 'clean snapshot');
});

await t('offline: queued writes and sign-in survive an app restart', async () => {
  const disk = new Map();
  const a1 = open({ map: disk });
  await a1.auth.signIn(`alice-${stamp}@test.dev`, 'secret1');
  await a1.disableNetwork();
  a1.db.doc('notes/restart1').set({ text: 'before restart', n: increment(1) });
  a1.db.doc('notes/restart1').update({ n: increment(1) });
  await sleep(150);
  await a1.close();
  ok(disk.get('queue')?.length === 2, 'queue saved');
  const a2 = open({ map: disk });
  await a2.ready;
  eq(a2.auth.currentUser?.uid, aliceUid, 'still signed in');
  eq((await a2.db.doc('notes/restart1').get({ source: 'cache' })).data().n, 2, 'local view');
  const unsub = a2.db.collection('notes').onSnapshot(() => {});
  await a2.waitForPendingWrites();
  eq((await bob.db.doc('notes/restart1').get()).data(), { text: 'before restart', n: 2 }, 'server got it once');
  unsub();
});

await t('anonymous users can upgrade and keep their uid', async () => {
  await bob.auth.signUp(`bob-${stamp}@test.dev`, 'secret2');
  eq(bob.auth.currentUser.uid, bobUid);
  ok(!bob.auth.currentUser.anon);
  eq((await bob.db.doc(`users/${bobUid}/notes/n1`).get()).data(), { hi: 1 });
});

await t('storage: upload, links, rules, list, delete', async () => {
  const f = await alice.storage.upload(`avatars/${aliceUid}/hi.txt`, 'hello world', { contentType: 'text/plain' });
  eq([f.size, f.type], [11, 'text/plain']);
  const r = await fetch(f.url);
  eq(await r.text(), 'hello world', 'public link');
  eq((await (await alice.storage.download(`avatars/${aliceUid}/hi.txt`)).text()), 'hello world');
  await rejects(bob.storage.upload(`avatars/${aliceUid}/evil.txt`, 'x'), 'permission-denied');
  await rejects(alice.storage.upload(`avatars/${aliceUid}/big.bin`, new Uint8Array(2000)), 'permission-denied');
  await rejects(alice.storage.upload(`docs/x.txt`, 'x'), 'permission-denied');
  eq((await alice.storage.list(`avatars/${aliceUid}/`)).map(x => x.name), ['hi.txt']);
  eq((await fetch(f.url.replace(/t=[^&]+/, 't=wrong'))).status, 200, 'rules allow public read anyway');
  await alice.storage.delete(`avatars/${aliceUid}/hi.txt`);
  eq((await alice.storage.list(`avatars/${aliceUid}/`)).length, 0);
});

await t('hosting: CLI login and deploy, clean URLs, 404s, redeploy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rennko-home-'));
  const site = mkdtempSync(join(tmpdir(), 'rennko-site-'));
  mkdirSync(join(site, 'css'));
  writeFileSync(join(site, 'index.html'), '<h1>Hello from Rennko</h1>');
  writeFileSync(join(site, 'about.html'), '<h1>About</h1>');
  writeFileSync(join(site, 'css', 'app.css'), 'body{color:red}');
  writeFileSync(join(site, '404.html'), '<h1>Custom 404</h1>');
  const cli = (...a) => execFileSync('node', [join(ROOT, 'cli/rennko.mjs'), ...a], { env: { ...process.env, RENNKO_HOME: home }, encoding: 'utf8' });
  ok(cli('login', '--host', BASE, '--email', `dev1-${stamp}@test.dev`, '--password', 'password1').includes('Signed in'));
  ok(cli('projects').includes(P));
  const out = cli('deploy', '--project', P, '--dir', site, '--clean-urls');
  ok(out.includes('4 new or changed') && out.includes('Live'), out);
  let r = await req(`/p/${P}/`);
  ok(String(r.d).includes('Hello from Rennko'), 'index');
  eq(r.r.headers.get('content-type'), 'text/html; charset=utf-8');
  ok(String((await req(`/p/${P}/about`)).d).includes('About'), 'clean url');
  eq((await req(`/p/${P}/css/app.css`)).r.headers.get('content-type'), 'text/css');
  r = await req(`/p/${P}/nope`);
  eq(r.status, 404);
  ok(String(r.d).includes('Custom 404'));
  eq((await req(`/p/${P}`)).status, 301, 'adds trailing slash');
  writeFileSync(join(site, 'index.html'), '<title>Demo &amp; Co</title><meta name="description" content="A test site"><meta property="og:image" content="/og.png"><h1>Version two</h1>');
  ok(cli('deploy', '--project', P, '--dir', site).includes('1 new or changed'), 'only changed files upload');
  ok(String((await req(`/p/${P}/`)).d).includes('Version two'));
  eq((await req(`/p/${P}/about`)).status, 404, 'clean urls now off');
  const init = await req(`/p/${P}/__/init.js`);
  ok(String(init.d).includes(`initApp({ url: "${BASE}/p/${P}" })`), 'init.js');
  eq((await req(`/p/${P}/__/rennko.js`)).status, 200);
});

await t('discover: daily visits, opt-out and the Top 5', async () => {
  const site = async (headers = {}) => fetch(`${BASE}/p/${P}/`, { headers: { 'user-agent': 'Mozilla/5.0 (test)', ...headers } });
  const todayOf = async () => { await sleep(250); const d = await (await fetch(`${BASE}/v1/discover`)).json(); return { d, me: d.sites.find(s => s.id === P) }; };
  const before = (await todayOf()).me?.today ?? 0;
  const r = await site();
  const cookie = r.headers.get('set-cookie') || '';
  ok(cookie.includes('rk_seen=') && cookie.includes(`Path=/p/${P}/`), 'visit cookie: ' + cookie);
  await site({ cookie: cookie.split(';')[0] });
  await site({ 'user-agent': 'Googlebot/2.1' });
  let { d, me } = await todayOf();
  eq(me?.today, before + 1, 'one visit per visitor per day, bots skipped');
  eq([me.title, me.description, me.image], ['Demo & Co', 'A test site', `${BASE}/p/${P}/og.png`], 'listing from index.html');
  ok(me.total >= me.today && me.url === `${BASE}/p/${P}` && d.top.some(s => s.id === P), 'listed and in the top');
  eq((await req(`/p/${P}/__/admin/settings`, { method: 'PUT', body: { discover: false }, token: tok1 })).status, 200);
  ok(!(await todayOf()).d.sites.some(s => s.id === P), 'hidden when opted out');
  await req(`/p/${P}/__/admin/settings`, { method: 'PUT', body: { discover: true }, token: tok1 });
  ok((await todayOf()).d.sites.some(s => s.id === P), 'back after opting in');
  ok(String((await req('/site/discover')).d).includes('Top 5 today') && String((await req('/site/top')).d).includes('Top 5'), 'pages');
});

await t('console admin: users, collections, delete user', async () => {
  const users = await req(`/p/${P}/__/admin/users`, { token: tok1 });
  ok(users.d.total >= 2);
  const cols = (await req(`/p/${P}/__/admin/collections`, { token: tok1 })).d.collections.map(c => c.name);
  ok(['chat', 'items', 'notes', 'todos'].every(c => cols.includes(c)), cols.join());
  const victim = open();
  await victim.auth.signInAnonymously();
  const uid = victim.auth.currentUser.uid;
  eq((await req(`/p/${P}/__/admin/users/${uid}`, { method: 'DELETE', token: tok1 })).status, 200);
  await victim.auth._refresh();
  eq(victim.auth.currentUser, null, 'deleted user signed out');
});

await t('admin SDK (console token) sees everything live', async () => {
  const adm = open({ token: () => dev1.auth.getToken(), persistence: false });
  eq((await adm.db.collection('todos').get()).size, 1, 'skips rules');
  const seen = [];
  adm.db.collection('todos').onSnapshot(s => seen.push(s.size));
  await waitFor(() => seen.length && adm.online, 5000, 'admin listener');
  await alice.db.doc('todos/t2').set({ owner: aliceUid });
  await waitFor(() => seen.includes(2), 5000, 'admin live update');
});

await t("can't-find screens and the website", async () => {
  let r = await req('/p/nobody-here-' + stamp + '/');
  eq(r.status, 404);
  ok(String(r.d).includes('up for grabs') && String(r.d).includes('#/new?name=nobody-here-'), 'free name screen');
  r = await req('/p/ab/');
  ok(r.status === 404 && String(r.d).includes('a name we can host'), 'invalid name screen');
  r = await req('/p/admin/');
  ok(r.status === 404 && String(r.d).includes('reserved'), 'reserved name screen');
  r = await req(`/p/${P}/definitely-missing`);
  eq(r.status, 404, 'missing page in a deployed site still 404s');
  ok(String((await req('/site/')).d).includes('free</em> backend'), 'website');
  ok(String((await req('/site/docs')).d).includes('Security rules'), 'docs');
});

await t('GitHub sign-in setup, origin checks and hidden secrets', async () => {
  const set = await req(`/p/${P}/__/admin/settings`, { method: 'PUT', token: tok1, body: { oauth: { github: { clientId: 'gh-client-123', clientSecret: 'shh-secret' } }, authorizedOrigins: ['https://myapp.example/path'] } });
  eq(set.status, 200);
  ok(!JSON.stringify(set.d).includes('shh-secret') && set.d.oauth.github.secretSet, 'secret never echoed');
  ok(!JSON.stringify((await req(`/p/${P}/__/admin/info`, { token: tok1 })).d).includes('shh-secret'), 'not in info either');
  eq((await req(`/p/${P}/__/info`)).d.providers, { github: true, google: false });
  let r = await req(`/p/${P}/__/auth/oauth/github?origin=${encodeURIComponent(BASE)}&mode=signin`);
  eq(r.status, 302);
  const loc = new URL(r.r.headers.get('location'));
  eq([loc.host, loc.searchParams.get('client_id'), loc.searchParams.get('redirect_uri')], ['github.com', 'gh-client-123', `${BASE}/p/${P}/__/auth/oauth/github/callback`]);
  r = await req(`/p/${P}/__/auth/oauth/github?origin=${encodeURIComponent('https://myapp.example')}`);
  eq(r.status, 302, 'authorized domain allowed');
  r = await req(`/p/${P}/__/auth/oauth/github?origin=${encodeURIComponent('https://evil.example')}`);
  ok(r.status === 200 && String(r.d).includes("isn't an authorized domain") && String(r.d).includes('target = null'), 'other sites get nothing');
  r = await req(`/p/${P}/__/auth/oauth/github/callback?code=x&state=forged`);
  ok(String(r.d).includes('expired') && String(r.d).includes('target = null'), 'forged state rejected');
  r = await req(`/p/${P}/__/auth/oauth/github?origin=${encodeURIComponent(BASE)}&mode=link`);
  ok(String(r.d).includes('Sign in before connecting'), 'link needs a user');
  r = await req(`/p/${P}/__/auth/oauth/google?origin=${encodeURIComponent(BASE)}`);
  ok(String(r.d).includes("isn't set up"), 'unconfigured provider');
  await alice.auth.unlink('github');
  eq(alice.auth.currentUser.providers, []);
});

await t('rules: hasOnly, hasAll and serverTimestamp == now', async () => {
  const rules = { db: {
    'reports/{id}': { read: 'auth != null', create: "data.uid == auth.uid && data.keys().hasOnly(['uid', 'n', 'at']) && data.at == now" },
    'lsh/{b}': { read: 'auth != null', write: 'auth != null && (doc == null || data.repos.hasAll(doc.repos))' },
  } };
  eq((await req(`/p/${P}/__/admin/rules`, { method: 'PUT', body: rules, token: tok1 })).status, 200);
  await alice.db.doc('reports/r1').set({ uid: aliceUid, n: 1, at: serverTimestamp() });
  await rejects(alice.db.doc('reports/r2').set({ uid: aliceUid, n: 1, at: 5 }), 'permission-denied');
  await rejects(alice.db.doc('reports/r3').set({ uid: aliceUid, n: 1, at: serverTimestamp(), extra: true }), 'permission-denied');
  await alice.db.doc('lsh/b1').set({ repos: arrayUnion('a/b') }, { merge: true });
  await alice.db.doc('lsh/b1').set({ repos: arrayUnion('c/d') }, { merge: true });
  await rejects(alice.db.doc('lsh/b1').set({ repos: ['x/y'] }), 'permission-denied');
});

await t('Rennko Cloud admin: domains, suspensions, bans, blocked names', async () => {
  const boss = initApp({ url: BASE, storage: memoryStore() });
  apps.push(boss);
  await boss.auth.signUp('admin@test.dev', 'adminpass1');
  ok(boss.auth.currentUser.platformAdmin, 'admin flag');
  const bt = await boss.auth.getToken();
  eq((await req('/v1/admin/overview', { token: tok1 })).status, 403, 'non-admins blocked');
  const o = await req('/v1/admin/overview', { token: bt });
  eq(o.status, 200);
  const row = o.d.projects.find(p => p.id === P);
  ok(row && row.ownerEmail === `dev1-${stamp}@test.dev` && row.usage.users >= 2, 'domain row with owner and usage');
  ok(o.d.users.some(u => u.email === `dev2-${stamp}@test.dev`) && o.d.users.some(u => u.admin), 'developers listed');
  eq((await req(`/p/${P}/__/admin/info`, { token: bt })).status, 200, 'admin manages any project');

  // suspend and unsuspend a domain
  eq((await req(`/v1/admin/projects/${P}/suspend`, { body: { reason: 'spam' }, token: bt })).status, 200);
  let r = await req(`/p/${P}/`);
  ok(r.status === 451 && String(r.d).includes('suspended'), 'suspended screen');
  await rejects(alice.db.doc('reports/r1').get({ source: 'server' }), 'permission-denied');
  eq((await req(`/p/${P}/__/admin/info`, { token: tok1 })).d.suspended.reason, 'spam', 'owner sees why');
  eq((await req(`/p/${P}/__/admin/unsuspend`, { method: 'POST', body: {}, token: tok1 })).status, 403, 'owner cannot unsuspend');
  eq((await req(`/v1/admin/projects/${P}/unsuspend`, { body: {}, token: bt })).status, 200);
  ok((await alice.db.doc('reports/r1').get({ source: 'server' })).exists, 'back online');

  // ban and unban a developer
  const uid2 = dev2.auth.currentUser.uid, t2 = await dev2.auth.getToken();
  eq((await req(`/v1/admin/users/${uid2}/ban`, { body: { disabled: true }, token: bt })).status, 200);
  const again = initApp({ url: BASE, storage: memoryStore() });
  apps.push(again);
  await rejects(again.auth.signIn(`dev2-${stamp}@test.dev`, 'password2'), 'permission-denied');
  eq((await req('/v1/projects', { body: { id: 'banned-' + stamp }, token: t2 })).status, 403, 'banned devs cannot create projects');
  await dev2.auth._refresh();
  eq(dev2.auth.currentUser, null, 'banned dev signed out');
  eq((await req(`/v1/admin/users/${boss.auth.currentUser.uid}/ban`, { body: { disabled: true }, token: bt })).status, 412, 'admins cannot be banned');
  eq((await req(`/v1/admin/users/${uid2}/ban`, { body: { disabled: false }, token: bt })).status, 200);
  await dev2.auth.signIn(`dev2-${stamp}@test.dev`, 'password2');

  // blocked names
  eq((await req('/v1/admin/blocked-names', { method: 'PUT', body: { names: ['nope-' + stamp] }, token: bt })).status, 200);
  eq((await req('/v1/projects', { body: { id: 'nope-' + stamp }, token: tok1 })).status, 409, 'blocked name');

  // owners ban their own app's users
  const v = open();
  await v.auth.signInAnonymously();
  eq((await req(`/p/${P}/__/admin/users/${v.auth.currentUser.uid}`, { method: 'PUT', body: { disabled: true }, token: tok1 })).status, 200);
  await rejects(v.db.doc('reports/r1').get({ source: 'server' }), 'permission-denied');
  const listed = (await req(`/p/${P}/__/admin/users?q=${v.auth.currentUser.uid}`, { token: tok1 })).d.users[0];
  ok(listed.disabled, 'shown as banned');
});

await t('deleting a project wipes it', async () => {
  const r = await req(`/v1/projects/${P}`, { method: 'DELETE', token: await dev2.auth.getToken() });
  eq(r.status, 404, 'not yours');
  eq((await req(`/v1/projects/${P}`, { method: 'DELETE', token: tok1 })).status, 200);
  eq((await req(`/p/${P}/__/info`)).status, 404);
  eq((await req(`/p/${P}/`)).status, 404);
  eq((await req('/v1/projects', { body: { id: P }, token: tok1 })).status, 201, 'name free again');
  eq((await req(`/p/${P}/__/admin/collections`, { token: tok1 })).d.collections, [], 'fresh and empty');
});

for (const a of apps) await a.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
