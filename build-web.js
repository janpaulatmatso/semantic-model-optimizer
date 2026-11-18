/* Builds the web version: the interface as static files that run in the browser only.
 *   node build-web.js [outDir]   (default dist/web)
 * It takes every local script, stylesheet and icon that index.html refers to, so the list never runs out of date.
 * The page gets a Content Security Policy that forbids every connection: whatever is loaded stays in the browser.
 * It is also an installable app (PWA): a manifest, icons and a service worker that keeps the files for offline use. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const icon = require('./icon.js');

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "manifest-src 'self'", "worker-src 'self'",
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'",
].join('; ');

/** The local files index.html refers to (scripts, stylesheets, icons). */
function assets(html) {
  const out = [];
  for (const m of html.matchAll(/\s(?:src|href)="([^"#?:]+)"/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** local.js: web-local.js with the app's own modules for changing files, which then use a file system in memory. */
const LOCAL_MODULES = ['web-local.js', 'loader.js', 'edit.js', 'remove.js', 'fix.js'];
function localBundle() {
  const defs = LOCAL_MODULES.map(f => JSON.stringify('./' + f) + ': function (module, exports, require) {\n' +
    fs.readFileSync(path.join(__dirname, f), 'utf8') + '\n}').join(',\n');
  return `/* Semantic Model Optimizer, web version: changes to a folder the user picked. Built by build-web.js from
 * ${LOCAL_MODULES.join(', ')}; see web-local.js. */
(function () {
'use strict';
const defs = {
${defs}
};
const cache = {};
let local = null;
const builtin = {
  './core.js': () => globalThis.SMO,
  fs: () => new Proxy({}, { get: (_, k) => local.current.fs[k] }),
  path: () => local.pathShim,
  zlib: () => ({ inflateRawSync: () => { throw new Error('Not available in the web version.'); } }),
};
function req(name) {
  if (cache[name]) return cache[name].exports;
  const module = cache[name] = { exports: {} };
  if (builtin[name]) module.exports = builtin[name]();
  else if (defs[name]) defs[name](module, module.exports, req);
  else throw new Error('Unknown module ' + name);
  return module.exports;
}
local = req('./web-local.js');
local.setModules(() => ({ loader: req('./loader.js'), edit: req('./edit.js'), remove: req('./remove.js'), fix: req('./fix.js') }));
globalThis.SMOLocal = local;
})();
`;
}

/** The page as published: with the policy, the edition marker, the manifest, and local.js. */
function webPage(html) {
  if (!/<meta charset="utf-8">/i.test(html)) throw new Error('index.html has no <meta charset="utf-8">');
  if (!/<script src="core.js"><\/script>/.test(html)) throw new Error('index.html has no <script src="core.js">');
  html = html.replace('<script src="core.js"></script>', '<script src="core.js"></script>\n<script src="local.js"></script>');
  return html.replace(/(<meta charset="utf-8">)/i, [
    '$1',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="smo-edition" content="web">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#12151b" media="(prefers-color-scheme: dark)">',
  ].join('\n'));
}

/** The app manifest: how it looks once installed, and which files Windows may open with it. */
function manifest() {
  return {
    name: 'Semantic Model Optimizer',
    short_name: 'Model Optimizer',
    description: 'Which measures and columns of a Power BI model are used, their lineage, and checks. Runs in the browser; nothing leaves the computer.',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#f6f7f9',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    file_handlers: [{
      action: './',
      accept: {
        'application/octet-stream': ['.pbix', '.pbit', '.vpax'],
        'application/json': ['.bim'],
      },
    }],
    launch_handler: { client_mode: 'focus-existing' },
  };
}

/** The service worker: keeps this version's files, answers from them (also offline), drops older versions. */
function serviceWorker(files, version) {
  return `/* Semantic Model Optimizer, web version ${version}: keeps its own files for offline use. It fetches nothing else. */
'use strict';
const CACHE = 'smo-${version}';
const FILES = ${JSON.stringify(['./'].concat(files))};
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
`;
}

function build(out) {
  const root = __dirname;
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const generated = {
    'favicon.ico': () => icon.ico([16, 32, 48, 256]), 'icon.png': () => icon.png(256),
    'icon-192.png': () => icon.png(192), 'icon-512.png': () => icon.png(512),
  };
  const files = assets(html).concat(['icon-192.png', 'icon-512.png'].filter(f => !assets(html).includes(f)));
  const write = (f, body) => fs.writeFileSync(path.join(out, f), body);
  for (const f of files) {
    if (generated[f]) write(f, generated[f]());
    else fs.copyFileSync(path.join(root, f), path.join(out, f));
  }
  write('index.html', webPage(html));
  write('local.js', localBundle());
  write('manifest.webmanifest', JSON.stringify(manifest(), null, 2));
  const all = ['index.html', 'local.js', 'manifest.webmanifest'].concat(files);
  // the version is a hash of every file, so a changed file means a new service worker and fresh files for everyone
  const hash = crypto.createHash('sha256');
  for (const f of all) hash.update(f).update(fs.readFileSync(path.join(out, f)));
  write('sw.js', serviceWorker(all, hash.digest('hex').slice(0, 12)));
  write('.nojekyll', '');
  return all.concat(['sw.js']);
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, 'dist', 'web'));
  const files = build(out);
  console.log('Web version in ' + out + ': ' + files.join(', '));
}

module.exports = { assets, webPage, manifest, serviceWorker, localBundle, build, CSP };
