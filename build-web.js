/* Builds the web version: the interface as static files that run in the browser only.
 *   node build-web.js [outDir]   (default dist/web)
 * It takes every local script, stylesheet and icon that index.html refers to, so the list never runs out of date.
 * The page gets a Content Security Policy that forbids every connection: whatever is loaded stays in the browser. */
'use strict';
const fs = require('fs');
const path = require('path');
const icon = require('./icon.js');

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'",
].join('; ');

/** The local files index.html refers to (scripts, stylesheets, icons). */
function assets(html) {
  const out = [];
  for (const m of html.matchAll(/\s(?:src|href)="([^"#?:]+)"/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The page as published: with the policy, and the icons it links to generated. */
function webPage(html) {
  if (!/<meta charset="utf-8">/i.test(html)) throw new Error('index.html has no <meta charset="utf-8">');
  return html.replace(/(<meta charset="utf-8">)/i, `$1\n<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<meta name="smo-edition" content="web">`);
}

function build(out) {
  const root = __dirname;
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const generated = { 'favicon.ico': () => icon.ico([16, 32, 48, 256]), 'icon.png': () => icon.png(256) };
  const files = assets(html);
  for (const f of files) {
    const dest = path.join(out, f);
    if (generated[f]) fs.writeFileSync(dest, generated[f]());
    else fs.copyFileSync(path.join(root, f), dest);
  }
  fs.writeFileSync(path.join(out, 'index.html'), webPage(html));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return ['index.html'].concat(files);
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, 'dist', 'web'));
  const files = build(out);
  console.log('Web version in ' + out + ': ' + files.join(', '));
}

module.exports = { assets, webPage, build, CSP };
