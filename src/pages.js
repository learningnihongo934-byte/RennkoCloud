// Full-page screens: the "can't find" screen for unclaimed or invalid subdomains, a new project's
// "nothing deployed yet" page, and plain 404s. All self-contained HTML.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LOGO = `<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><path d="M16 6c1 5 7 7 7 13a7 7 0 0 1-14 0c0-3 2-5 3-6 0 3 1 4 2 4 0-4 0-8 2-11z" fill="#fff"/></svg>`;

function embers(n = 22) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const left = (Math.random() * 100).toFixed(1), dur = (6 + Math.random() * 9).toFixed(1), delay = (-Math.random() * 15).toFixed(1);
    const size = (3 + Math.random() * 5).toFixed(1), dx = ((Math.random() - 0.5) * 160).toFixed(0);
    out += `<span style="left:${left}%;width:${size}px;height:${size}px;animation-duration:${dur}s;animation-delay:${delay}s;--dx:${dx}px"></span>`;
  }
  return out;
}

// kind: 'free' (nobody has this name), 'invalid', 'reserved', 'empty' (project exists, no site), 'missing' (no page at this path)
// url is the address to show in the bar, with the name highlighted.
export function screen({ kind, name, url, home, consoleUrl, siteUrl }) {
  const i = url.indexOf(name);
  const shown = i < 0 ? `<span class="dim">${esc(url)}</span>` : `<span class="dim">${esc(url.slice(0, i))}</span><b>${esc(name)}</b><span class="dim">${esc(url.slice(i + name.length))}</span>`;
  const bar = `<div class="bar" aria-label="${esc(url)}">${shown}<i class="cursor"></i></div>`;
  const claim = `${consoleUrl}/#/new?name=${encodeURIComponent(name)}`;
  const copy = {
    free: {
      big: '404', title: `${name} is up for grabs`, h1: 'Nobody lives here yet',
      p: 'This name is free. Claim it and your app can be live here in a minute, with free hosting, a realtime database and sign-in.',
      btns: `<a class="btn primary" href="${esc(claim)}">Claim ${esc(name)} →</a><a class="btn" href="${esc(siteUrl)}">What's Rennko Cloud?</a>`,
    },
    invalid: {
      big: '404', title: "That name can't be used", h1: "That's not a name we can host",
      p: 'Project names are 3 to 30 lowercase letters, numbers and single hyphens, starting with a letter.',
      btns: `<a class="btn primary" href="${esc(consoleUrl)}/#/new">Pick a name →</a><a class="btn" href="${esc(siteUrl)}">What's Rennko Cloud?</a>`,
    },
    reserved: {
      big: '404', title: `${name} is reserved`, h1: 'This one belongs to Rennko',
      p: `<b>${esc(name)}</b> is a reserved name, so nobody can claim it. Plenty of others are free.`,
      btns: `<a class="btn primary" href="${esc(consoleUrl)}/#/new">Pick another name →</a><a class="btn" href="${esc(siteUrl)}">What's Rennko Cloud?</a>`,
    },
    empty: {
      big: '🔥', title: `${name} is ready`, h1: 'Your project is live',
      p: 'Nothing is deployed here yet. Drop your site folder into the console\'s Hosting tab, or run <code>rennko deploy</code>, and it shows up right here.',
      btns: `<a class="btn primary" href="${esc(consoleUrl)}/#/p/${encodeURIComponent(name)}/hosting">Deploy a site →</a><a class="btn" href="${esc(siteUrl)}docs">Read the docs</a>`,
    },
    missing: {
      big: '404', title: 'Page not found', h1: "This page doesn't exist",
      p: 'The site is here, but there\'s nothing at this address.',
      btns: `<a class="btn primary" href="${esc(home)}">Go to the home page</a>`,
    },
  }[kind];
  const status = kind === 'empty' ? 200 : 404;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(copy.title)}</title><meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO.replace('var(--accent)', '#c2410c'))}">
<style>
:root{--bg:#0f0d0c;--text:#f4efe9;--dim:#a39a90;--accent:#f97316;--glow:#fdba74;--card:#1b1816;--line:#2f2a26;color-scheme:dark}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){--bg:#fbf7f2;--text:#1f1a16;--dim:#6f665d;--accent:#c2410c;--glow:#fb923c;--card:#ffffff;--line:#eadfd3;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse 80% 55% at 50% 115%,color-mix(in srgb,var(--accent) 30%,transparent),transparent 70%),var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
.embers span{position:fixed;bottom:-12px;border-radius:50%;background:var(--glow);box-shadow:0 0 10px var(--glow),0 0 22px var(--accent);opacity:0;animation:rise linear infinite;pointer-events:none}
@keyframes rise{0%{transform:translate(0,0) scale(1);opacity:0}8%{opacity:.95}70%{opacity:.6}100%{transform:translate(var(--dx),-108vh) scale(.2);opacity:0}}
main{position:relative;z-index:1;text-align:center;padding:2rem 16px;width:100%;max-width:42rem}
.logo{display:inline-flex;align-items:center;gap:.5rem;font-weight:800;color:var(--text);text-decoration:none;margin-bottom:1.2rem}
.big{font-size:clamp(5.5rem,24vw,11rem);font-weight:900;line-height:.9;letter-spacing:-.05em;background:linear-gradient(180deg,var(--glow) 10%,var(--accent) 55%,color-mix(in srgb,var(--accent) 10%,transparent));-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 6px 40px color-mix(in srgb,var(--accent) 45%,transparent));animation:flicker 4s ease-in-out infinite}
@keyframes flicker{0%,100%{opacity:1}45%{opacity:.93}50%{opacity:.82}55%{opacity:.95}}
.bar{display:inline-flex;align-items:center;gap:.05rem;margin:1.4rem 0 1rem;padding:.65rem 1.1rem;border-radius:999px;background:var(--card);border:1px solid var(--line);font:clamp(.9rem,3.6vw,1.12rem)/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;box-shadow:0 10px 40px -20px #000}
.bar b{color:var(--accent);font-weight:700}.dim{color:var(--dim)}
.cursor{display:inline-block;width:2px;height:1.15em;margin-left:3px;background:var(--accent);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
h1{font-size:clamp(1.5rem,5.5vw,2.2rem);line-height:1.2;margin:.3rem 0 .5rem}
p{color:var(--dim);margin:0 auto 1.8rem;max-width:32rem}
code{background:var(--card);border:1px solid var(--line);padding:.05em .4em;border-radius:6px;font-size:.9em}
.btns{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap}
.btn{padding:.8rem 1.35rem;border-radius:999px;font-weight:700;text-decoration:none;border:1px solid var(--line);color:var(--text);background:var(--card);transition:transform .15s}
.btn:hover{transform:translateY(-2px)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 10px 34px -10px var(--accent)}
footer{position:fixed;bottom:12px;left:0;right:0;text-align:center;font-size:13px;color:var(--dim);z-index:1}footer a{color:inherit}
@media (prefers-reduced-motion:reduce){.embers{display:none}.cursor,.big{animation:none}}
</style></head><body>
<div class="embers" aria-hidden="true">${embers()}</div>
<main>
  <a class="logo" href="${esc(siteUrl)}">${LOGO} Rennko Cloud</a>
  <div class="big" aria-hidden="true">${copy.big}</div>
  ${bar}
  <h1>${esc(copy.h1)}</h1>
  <p>${copy.p}</p>
  <div class="btns">${copy.btns}</div>
</main>
<footer>Free hosting, database and auth for your apps · <a href="${esc(siteUrl)}">Rennko Cloud</a></footer>
</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
