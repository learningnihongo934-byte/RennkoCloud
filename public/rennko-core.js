// Rennko Cloud shared core: document paths, write ops and query matching.
// Used by the server (src/) and the SDK (public/rennko.js) so both apply writes the same way.

const SEG = /^[^/\s][^/]{0,199}$/;

// "todos/abc" -> { col: "todos", id: "abc" }; nested: "users/u1/notes/n1" -> col "users/u1/notes"
export function parseDocPath(path) {
  const parts = String(path || '').split('/');
  if (parts.length < 2 || parts.length % 2 || !parts.every(p => SEG.test(p))) throw err('invalid-argument', `Bad document path "${path}"`);
  return { col: parts.slice(0, -1).join('/'), id: parts[parts.length - 1] };
}

export function checkColPath(col) {
  const parts = String(col || '').split('/');
  if (!(parts.length % 2) || !parts.every(p => SEG.test(p))) throw err('invalid-argument', `Bad collection path "${col}"`);
  return col;
}

export function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export const newId = () => {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const b = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(b, x => a[x % 62]).join('');
};

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isSv = v => isObj(v) && '.sv' in v;
const DELETE = Symbol('delete');

// Resolve sentinel values ({".sv": ...}) against the previous value at the same spot.
function resolve(v, prev, now) {
  if (isSv(v)) {
    const s = v['.sv'];
    if (s === 'timestamp') return now;
    if (s === 'delete') return DELETE;
    if (isObj(s) && 'increment' in s) return (typeof prev === 'number' ? prev : 0) + Number(s.increment || 0);
    if (isObj(s) && Array.isArray(s.arrayUnion)) {
      const out = Array.isArray(prev) ? clone(prev) : [];
      for (const x of s.arrayUnion) if (!out.some(y => same(x, y))) out.push(clone(x));
      return out;
    }
    if (isObj(s) && Array.isArray(s.arrayRemove)) return Array.isArray(prev) ? prev.filter(y => !s.arrayRemove.some(x => same(x, y))) : [];
    throw err('invalid-argument', 'Unknown field value');
  }
  if (isObj(v)) {
    const out = {};
    for (const k in v) { const r = resolve(v[k], isObj(prev) ? prev[k] : undefined, now); if (r !== DELETE) out[k] = r; }
    return out;
  }
  if (Array.isArray(v)) return v.map(x => resolve(x, undefined, now));
  return v;
}

function deepMerge(base, patch, now) {
  const out = isObj(base) ? clone(base) : {};
  for (const k in patch) {
    const v = patch[k];
    if (isObj(v) && !isSv(v)) out[k] = deepMerge(out[k], v, now);
    else { const r = resolve(v, out[k], now); if (r === DELETE) delete out[k]; else out[k] = r; }
  }
  return out;
}

function setPath(obj, dotted, v, now) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  const last = keys[keys.length - 1];
  const r = resolve(v, o[last], now);
  if (r === DELETE) delete o[last]; else o[last] = r;
}

// Apply one write op to the current data (null = missing). Returns the new data (null = deleted).
export function applyOp(op, current, now) {
  if (op.op === 'delete') return null;
  if (!isObj(op.data)) throw err('invalid-argument', 'Document data must be an object');
  if (op.op === 'set') return op.merge ? deepMerge(current, op.data, now) : resolve(op.data, current, now);
  if (op.op === 'update') {
    if (current == null) throw err('not-found', `No document to update: ${op.path}`);
    const out = clone(current);
    for (const k in op.data) setPath(out, k, op.data[k], now);
    return out;
  }
  throw err('invalid-argument', `Unknown op "${op.op}"`);
}

export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- queries ----
export const OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'];
const FIELD = /^(__id|[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*)$/;
export const MAX_LIMIT = 1000;

export function normQuery(q) {
  const out = { col: checkColPath(q.col), where: [], orderBy: [], limit: Math.min(Math.max(1, Number(q.limit) || MAX_LIMIT), MAX_LIMIT), offset: Math.max(0, Number(q.offset) || 0) };
  for (const w of q.where || []) {
    const [f, op, v] = w;
    if (!FIELD.test(f)) throw err('invalid-argument', `Bad field "${f}"`);
    if (!OPS.includes(op)) throw err('invalid-argument', `Bad operator "${op}"`);
    if (['in', 'not-in', 'array-contains-any'].includes(op) && (!Array.isArray(v) || v.length > 30)) throw err('invalid-argument', `"${op}" needs an array of up to 30 values`);
    out.where.push([f, op, v]);
  }
  for (const o of q.orderBy || []) {
    const [f, dir = 'asc'] = Array.isArray(o) ? o : [o];
    if (!FIELD.test(f)) throw err('invalid-argument', `Bad field "${f}"`);
    out.orderBy.push([f, dir === 'desc' ? 'desc' : 'asc']);
  }
  return out;
}

export const queryKey = q => JSON.stringify([q.col, q.where, q.orderBy, q.limit, q.offset]);

export function getField(doc, f) {
  if (f === '__id') return doc.id;
  let v = doc.data;
  for (const k of f.split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
  return v;
}

const rank = v => (v == null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : typeof v === 'string' ? 3 : 4);
export function cmp(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 4) { a = JSON.stringify(a); b = JSON.stringify(b); }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function matches(doc, w) {
  const [f, op, v] = w;
  const x = getField(doc, f);
  switch (op) {
    case '==': return v === null ? x == null : same(x, v);
    case '!=': return x !== undefined && x !== null && !same(x, v);
    case '<': return x != null && rank(x) === rank(v) && cmp(x, v) < 0;
    case '<=': return x != null && rank(x) === rank(v) && cmp(x, v) <= 0;
    case '>': return x != null && rank(x) === rank(v) && cmp(x, v) > 0;
    case '>=': return x != null && rank(x) === rank(v) && cmp(x, v) >= 0;
    case 'in': return v.some(y => same(x, y));
    case 'not-in': return x != null && !v.some(y => same(x, y));
    case 'array-contains': return Array.isArray(x) && x.some(y => same(y, v));
    case 'array-contains-any': return Array.isArray(x) && x.some(y => v.some(z => same(y, z)));
  }
  return false;
}

// Run a query over docs ({ path, id, data }) in memory. Mirrors the server's SQL.
export function runQuery(q, docs) {
  let out = docs.filter(d => q.where.every(w => matches(d, w)));
  const order = q.orderBy.length ? q.orderBy : [];
  out.sort((a, b) => {
    for (const [f, dir] of order) { const c = cmp(getField(a, f), getField(b, f)); if (c) return dir === 'desc' ? -c : c; }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out.slice(q.offset, q.offset + q.limit);
}
