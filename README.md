# Rennko Cloud

A free, open-source, **offline-first** alternative to Firebase. It gives your app:

- **Auth**: email/password, anonymous and Google sign-in. Anonymous users can upgrade to a real account and keep their data.
- **Realtime database**: Firestore-style collections and documents, with queries (`where`, `orderBy`, `limit`) and live `onSnapshot` listeners.
- **Offline sync**: the SDK caches data on the device (IndexedDB). Reads work with no connection, and writes show up instantly. Writes wait in a queue that survives reloads and sync when the device reconnects.
- **File storage**: uploads with shareable links, protected by rules.
- **Static hosting**: every project gets `https://<project>.rennko.tech`. Deploy by dragging a folder into the console or with `rennko deploy`.
- **Security rules**: a small, safe expression language for who can read and write what.
- **Discover**: a public list of hosted sites at https://cloud.rennko.tech/discover, ranked by today's visits, with a [Top 5 screen](https://cloud.rennko.tech/top). Owners can opt out in the console.
- **Console**: a dashboard at **https://console.rennko.tech** for your projects, live data, users, files, hosting and rules.

Everything runs on Cloudflare (Workers and SQLite Durable Objects) and fits the **free plan with no credit card**. Your apps keep running when your computer is off. The same code also runs fully offline on your laptop for development.

## Use it

1. Sign up at https://console.rennko.tech and create a project, say `my-app`.
2. Add it to any web page. No install or build step is needed:

```html
<script type="module">
  import { app, serverTimestamp } from 'https://my-app.rennko.tech/__/init.js';

  await app.auth.signInAnonymously();
  const chat = app.db.collection('messages');

  // Live query: fires right away from the offline cache, then on every change
  chat.orderBy('at').limit(50).onSnapshot(snap => {
    for (const change of snap.docChanges()) console.log(change.type, change.doc.data());
  });

  chat.add({ text: 'Hello!', uid: app.auth.currentUser.uid, at: serverTimestamp() });
</script>
```

3. Deploy your site from the console's **Hosting** tab, or from the terminal:

```bash
npx github:learningnihongo934-byte/RennkoCloud login
npx github:learningnihongo934-byte/RennkoCloud deploy --project my-app --dir ./public
```

## SDK reference

```js
import { initApp, serverTimestamp, increment, arrayUnion, arrayRemove, deleteField } from 'https://console.rennko.tech/rennko.js';
const app = initApp('https://my-app.rennko.tech');

// Auth
await app.auth.signUp(email, password);          // also upgrades an anonymous user in place
await app.auth.signIn(email, password);
await app.auth.signInAnonymously();
await app.auth.signInWithGoogle();               // or app.auth.renderGoogleButton(element)
app.auth.onAuthChange(user => {});               // user is null when signed out; works offline
await app.auth.signOut();

// Database
const ref = app.db.doc('todos/abc');
await ref.set({ text: 'hi', done: false });
await ref.set({ tags: ['x'] }, { merge: true });
await ref.update({ count: increment(1), 'meta.seen': true });
await ref.delete();
const snap = await ref.get();                    // snap.exists, snap.data(), snap.metadata.fromCache
app.db.collection('todos').where('done', '==', false).orderBy('at', 'desc').limit(20).onSnapshot(s => {});
const batch = app.db.batch(); batch.set(a, {...}); batch.delete(b); await batch.commit();   // all or nothing

// Storage
const file = await app.storage.upload('avatars/me.png', blob);   // file.url is a shareable link
await app.storage.list('avatars/');
await app.storage.delete('avatars/me.png');

// Connection
app.onConnectionChange(online => {});
await app.disableNetwork(); await app.enableNetwork();
await app.waitForPendingWrites();
```

Query operators: `== != < <= > >= in not-in array-contains array-contains-any`. Use the field `__id` to filter or sort by document ID.

Write promises resolve once the server has the write. Offline they stay pending, but listeners update right away. So in an offline-friendly UI, don't `await` writes before updating the screen.

## Security rules

Set rules in the console's **Rules** tab, or with `rennko deploy --rules rules.json`:

```json
{
  "db": {
    "users/{uid}/**": { "read": "auth.uid == uid", "write": "auth.uid == uid" },
    "posts/{id}": {
      "read": "true",
      "create": "data.owner == auth.uid && data.text.size() < 500",
      "update": "doc.owner == auth.uid && data.owner == auth.uid",
      "delete": "doc.owner == auth.uid"
    }
  },
  "storage": {
    "avatars/{uid}/**": { "read": "true", "write": "auth.uid == uid && data.size < 5000000", "delete": "auth.uid == uid" }
  }
}
```

- `{name}` matches one path segment, and `**` (or `{name=**}`) matches the rest.
- Actions are `read` (`get`, `list`) and `write` (`create`, `update`, `delete`). A request is allowed if **any** matching rule allows it.
- On a delete, `data` is `null`. A `write` rule that checks `data` therefore blocks deletes, so add a separate `delete` rule.
- Conditions can use:
  - `auth`: `uid`, `email`, `anon` and `provider`, or `null` when signed out.
  - `doc`: the stored data.
  - `data`: the incoming data. For files this has `size` and `type`.
  - `now`, and your path variables.
- Operators: `== != < <= > >= && || ! + - in`, plus `.size() .includes(x) .startsWith(s) .endsWith(s) .keys()`.
- Queries return only the documents the user is allowed to `list`.
- New projects start with "signed-in users can read and write everything".
- The console and the admin key (`x-admin-key` header) skip rules.

## Run your own copy (free)

You need Node 20+ and a free Cloudflare account.

```bash
git clone https://github.com/learningnihongo934-byte/RennkoCloud && cd RennkoCloud
./build.sh            # whole platform on http://localhost:8787, works with no internet
./build.sh test       # end-to-end tests against a local server
./build.sh deploy     # deploy to your Cloudflare account
```

Locally, the console is at `http://localhost:8787` and projects are at `http://localhost:8787/p/<id>/`. To use your own domain, change `BASE_DOMAIN` and the route in `wrangler.jsonc`. Add a proxied wildcard DNS record (`*`, AAAA `100::`) to the zone.

## How it works

| Piece | Where |
| --- | --- |
| Router: `<id>.rennko.tech`, `/p/<id>/`, console, `/v1` platform API | `src/worker.js` |
| One SQLite Durable Object per project: users, docs, live subscriptions (hibernating WebSockets), files, site | `src/project.js` |
| Security rules engine (parser and evaluator, no `eval`) | `src/rules.js` |
| Tokens (HS256, a key per project), PBKDF2 passwords, Google ID tokens | `src/crypto.js` |
| Write ops and query matching shared by server and SDK | `public/rennko-core.js` |
| SDK | `public/rennko.js` |
| Console (itself a Rennko Cloud app) | `public/index.html`, `public/console.js` |
| CLI | `cli/rennko.mjs` |

Files and hosted sites are stored content-addressed in 1.5 MB chunks inside each project's SQLite database, so no R2 (and no card) is needed. Hosted pages are cached at the edge for `HOSTING_CACHE` seconds.

## Free-plan limits

Cloudflare's free plan is shared by everyone on one deployment:

- About 100k requests per day. Realtime messages are much cheaper than requests.
- 5 GB of storage in total.

Each project is capped at `PROJECT_CAP_MB` (default 500 MB), each file at `MAX_FILE_MB` (25 MB), and each account at `MAX_PROJECTS` (5). Change these in `wrangler.jsonc`.

Not included yet: email verification and password-reset emails, server functions, and a "count" aggregation.

---

Made by **Virat Reddy Kaukuntla** ([@learningnihongo934-byte](https://github.com/learningnihongo934-byte))
