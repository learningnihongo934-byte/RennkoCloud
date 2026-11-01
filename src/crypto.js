// Tokens (HS256 JWT), password hashing and Google ID token checks, all on WebCrypto.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Each project signs tokens with its own key, derived from the one SECRET.
const keys = new Map();
async function projectKey(secret, project) {
  const k = `${project}`;
  if (!keys.has(k)) {
    const master = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const raw = await crypto.subtle.sign('HMAC', master, enc.encode('rennko-project:' + project));
    keys.set(k, await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return keys.get(k);
}

export async function signToken(secret, project, claims, ttlSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({ ...claims, p: project, iat: now, exp: now + ttlSec })));
  const sig = await crypto.subtle.sign('HMAC', await projectKey(secret, project), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// Returns the claims, or null if the token is bad or expired.
export async function verifyToken(secret, token) {
  try {
    const [head, body, sig] = String(token).split('.');
    const claims = JSON.parse(dec.decode(unb64url(body)));
    if (!claims.p || !claims.exp || claims.exp < Date.now() / 1000) return null;
    const ok = await crypto.subtle.verify('HMAC', await projectKey(secret, claims.p), unb64url(sig), enc.encode(`${head}.${body}`));
    return ok ? claims : null;
  } catch {
    return null;
  }
}

// 50k PBKDF2 rounds fits the free plan's CPU budget; the count is stored so it can be raised later.
export const PBKDF2_ITERATIONS = 50000;

export async function hashPassword(password, iter = PBKDF2_ITERATIONS, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64url(salt)}$${b64url(bits)}`;
}

export async function checkPassword(password, stored) {
  const [, iter, salt] = String(stored).split('$');
  if (!iter) return false;
  const again = await hashPassword(password, Number(iter), unb64url(salt));
  let diff = again.length ^ stored.length;
  for (let i = 0; i < again.length && i < stored.length; i++) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

let googleKeys = { at: 0, keys: [] };
export async function verifyGoogleIdToken(idToken, clientId) {
  if (!clientId) throw Object.assign(new Error('Google sign-in is not set up for this project (add a Google client ID in the console)'), { code: 'failed-precondition' });
  const [head, body, sig] = String(idToken).split('.');
  const h = JSON.parse(dec.decode(unb64url(head)));
  const c = JSON.parse(dec.decode(unb64url(body)));
  if (Date.now() - googleKeys.at > 3600e3) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    googleKeys = { at: Date.now(), keys: (await r.json()).keys };
  }
  const jwk = googleKeys.keys.find(k => k.kid === h.kid);
  if (!jwk) throw Object.assign(new Error('Unknown Google key'), { code: 'unauthenticated' });
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(sig), enc.encode(`${head}.${body}`));
  const issOk = c.iss === 'accounts.google.com' || c.iss === 'https://accounts.google.com';
  if (!ok || !issOk || c.aud !== clientId || c.exp < Date.now() / 1000) throw Object.assign(new Error('Invalid Google token'), { code: 'unauthenticated' });
  return c;
}
