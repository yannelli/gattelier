import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = ['index.html', 'app.bundle.js', 'app.bundle.css', 'vendors.json', 'metadata-v1.json',
  'manifest.webmanifest', 'icons/nanoscope-180.png', 'icons/nanoscope-192.png', 'icons/nanoscope-512.png'];
const hash = createHash('sha256');
await mkdir(`${root}dist/icons`, { recursive: true });
await mkdir(`${root}dist/licenses`, { recursive: true });
for (const name of ['DEXCOM-CRYPTO-NOTICE.md', 'licenses/GPL-3.0-or-later.txt']) {
  const content = await readFile(`${root}${name}`); hash.update(name).update(content);
  await writeFile(`${root}dist/${name}`, content);
}
for (const name of assets) {
  let content = await readFile(`${root}web/${name}`);
  if (name === 'index.html') content = Buffer.from(content.toString().replace('</head>', '  <meta name="nanoscope-hosted" content="true">\n</head>'));
  hash.update(name).update(content);
  await writeFile(`${root}dist/${name}`, content);
}
const serviceWorker = await readFile(`${root}web/sw.js`, 'utf8');
hash.update(serviceWorker);
const version = hash.digest('hex').slice(0, 16);
await writeFile(`${root}dist/sw.js`, serviceWorker.replaceAll('__NANO_BUILD__', version));
await writeFile(`${root}dist/_headers`, `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' http: https:; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'
  Cache-Control: no-cache
/metadata-v1.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300
/sw.js
  Service-Worker-Allowed: /
  Cache-Control: no-store
`);
await writeFile(`${root}dist/404.html`, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found</title><h1>Page not found</h1><p><a href="/">Open Gattelier</a></p></html>\n');
console.log(`Gattelier app ${version}: ${assets.length + 1} public assets in dist/`);
