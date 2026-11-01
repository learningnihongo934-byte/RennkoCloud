// Security rules. A project's rules look like:
//   { "db":      { "todos/{id}": { "read": "auth != null", "write": "data.owner == auth.uid" } },
//     "storage": { "avatars/{uid}/**": { "read": "true", "write": "auth.uid == uid" } } }
// Patterns match document (or file) paths segment by segment; {name} binds a segment and ** matches the rest.
// An action is allowed if any matching pattern allows it. Actions: get/list fall back to read,
// create/update/delete fall back to write. Expressions are a small safe language (no eval):
// literals, auth, doc (stored data), data (incoming data), now, path variables,
// == != < <= > >= && || ! + - in, a.b, a[b], and x.size() x.includes(y) x.startsWith(s) x.endsWith(s) x.keys()
// x.hasAll(list) x.hasAny(list) x.hasOnly(list).

export const DEFAULT_RULES = {
  db: { '**': { read: 'auth != null', write: 'auth != null' } },
  storage: { '**': { read: 'auth != null', write: 'auth != null' } },
};

export const LOCKED_RULES = { db: {}, storage: {} };

const FALLBACK = { get: 'read', list: 'read', create: 'write', update: 'write', delete: 'write' };

export function matchPattern(pattern, path) {
  const ps = pattern.split('/'), xs = path.split('/');
  const vars = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === '**') return vars;
    if (i >= xs.length) return null;
    const m = p.match(/^\{(\w+)(=\*\*)?\}$/);
    if (m && m[2]) { vars[m[1]] = xs.slice(i).join('/'); return vars; }
    if (m) vars[m[1]] = xs[i];
    else if (p !== xs[i]) return null;
  }
  return ps.length === xs.length ? vars : null;
}

const cache = new Map();
export function allowed(section, path, action, ctx) {
  if (!section) return false;
  for (const pattern in section) {
    const vars = matchPattern(pattern, path);
    if (!vars) continue;
    const rule = section[pattern] || {};
    const expr = rule[action] ?? rule[FALLBACK[action]];
    if (expr == null) continue;
    try {
      if (!cache.has(expr)) cache.set(expr, parse(String(expr)));
      if (evaluate(cache.get(expr), { ...vars, ...ctx }) === true) return true;
    } catch { /* a broken or failing rule denies */ }
  }
  return false;
}

// Throws with a readable message if any rule expression doesn't parse.
export function validateRules(rules) {
  if (!rules || typeof rules !== 'object') throw new Error('Rules must be a JSON object');
  for (const sec of ['db', 'storage']) {
    const s = rules[sec] || {};
    if (typeof s !== 'object') throw new Error(`"${sec}" must be an object`);
    for (const pat in s) for (const act in s[pat]) {
      if (!['read', 'write', ...Object.keys(FALLBACK)].includes(act)) throw new Error(`${sec} "${pat}": unknown action "${act}"`);
      try { parse(String(s[pat][act])); } catch (e) { throw new Error(`${sec} "${pat}" ${act}: ${e.message}`); }
    }
  }
}

// ---- tiny expression language ----
function lex(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*)|(==|!=|<=|>=|&&|\|\||[<>!+\-.()[\],]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    const at = re.lastIndex;
    if (!(m = re.exec(src))) throw new Error(`Unexpected "${src.slice(at, at + 10)}"`);
    if (m[1]) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) out.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
    else if (m[3]) out.push({ t: 'id', v: m[3] });
    else out.push({ t: 'op', v: m[4] });
  }
  return out;
}

export function parse(src) {
  const toks = lex(src);
  let i = 0;
  const peek = v => toks[i] && toks[i].t === 'op' && toks[i].v === v;
  const eat = v => { if (!peek(v)) throw new Error(`Expected "${v}"`); i++; };
  const bin = (next, ops) => () => {
    let l = next();
    while (toks[i] && ((toks[i].t === 'op' && ops.includes(toks[i].v)) || (toks[i].t === 'id' && ops.includes(toks[i].v)))) {
      const op = toks[i++].v;
      l = { k: 'bin', op, l, r: next() };
    }
    return l;
  };
  const primary = () => {
    const t = toks[i++];
    if (!t) throw new Error('Unexpected end');
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      return { k: 'var', v: t.v };
    }
    if (t.v === '(') { const e = or(); eat(')'); return e; }
    if (t.v === '[') {
      const items = [];
      while (!peek(']')) { items.push(or()); if (!peek(']')) eat(','); }
      eat(']');
      return { k: 'list', items };
    }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const postfix = () => {
    let e = primary();
    for (;;) {
      if (peek('.')) {
        i++;
        const name = toks[i++];
        if (!name || name.t !== 'id') throw new Error('Expected a name after "."');
        if (peek('(')) {
          i++;
          const args = [];
          while (!peek(')')) { args.push(or()); if (!peek(')')) eat(','); }
          eat(')');
          e = { k: 'call', obj: e, name: name.v, args };
        } else e = { k: 'get', obj: e, key: { k: 'lit', v: name.v } };
      } else if (peek('[')) { i++; const key = or(); eat(']'); e = { k: 'get', obj: e, key }; }
      else return e;
    }
  };
  const unary = () => {
    if (peek('!')) { i++; return { k: 'not', e: unary() }; }
    if (peek('-')) { i++; return { k: 'neg', e: unary() }; }
    return postfix();
  };
  const add = bin(unary, ['+', '-']);
  const rel = bin(add, ['<', '<=', '>', '>=', 'in']);
  const eq = bin(rel, ['==', '!=']);
  const and = bin(eq, ['&&']);
  const or = bin(and, ['||']);
  const ast = or();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
  return ast;
}

const eqv = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const METHODS = {
  size: x => (Array.isArray(x) || typeof x === 'string' ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0),
  includes: (x, y) => (Array.isArray(x) ? x.some(v => eqv(v, y)) : typeof x === 'string' ? x.includes(y) : false),
  startsWith: (x, y) => typeof x === 'string' && x.startsWith(y),
  endsWith: (x, y) => typeof x === 'string' && x.endsWith(y),
  keys: x => (x && typeof x === 'object' ? Object.keys(x) : []),
  hasAll: (x, ys) => Array.isArray(x) && Array.isArray(ys) && ys.every(y => x.some(v => eqv(v, y))),
  hasAny: (x, ys) => Array.isArray(x) && Array.isArray(ys) && ys.some(y => x.some(v => eqv(v, y))),
  hasOnly: (x, ys) => Array.isArray(x) && Array.isArray(ys) && x.every(v => ys.some(y => eqv(v, y))),
};

export function evaluate(n, env) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'var': return Object.prototype.hasOwnProperty.call(env, n.v) ? env[n.v] : null;
    case 'list': return n.items.map(x => evaluate(x, env));
    case 'not': return !evaluate(n.e, env);
    case 'neg': return -evaluate(n.e, env);
    case 'get': {
      const o = evaluate(n.obj, env), k = evaluate(n.key, env);
      return o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null;
    }
    case 'call': {
      const f = METHODS[n.name];
      if (!f) throw new Error(`Unknown function ${n.name}()`);
      return f(evaluate(n.obj, env), ...n.args.map(a => evaluate(a, env)));
    }
    case 'bin': {
      if (n.op === '&&') return evaluate(n.l, env) === true && evaluate(n.r, env) === true;
      if (n.op === '||') return evaluate(n.l, env) === true || evaluate(n.r, env) === true;
      const a = evaluate(n.l, env), b = evaluate(n.r, env);
      switch (n.op) {
        case '==': return eqv(a, b);
        case '!=': return !eqv(a, b);
        case '<': return a != null && b != null && a < b;
        case '<=': return a != null && b != null && a <= b;
        case '>': return a != null && b != null && a > b;
        case '>=': return a != null && b != null && a >= b;
        case '+': return a + b;
        case '-': return a - b;
        case 'in': return Array.isArray(b) ? b.some(v => eqv(v, a)) : b && typeof b === 'object' ? Object.prototype.hasOwnProperty.call(b, a) : false;
      }
    }
  }
  throw new Error('Bad expression');
}
