import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const scripts = [
  'catalog-schema', 'catalog-match', 'catalogs', 'vendors', 'packets', 'pklg', 'btsnoop', 'recorders', 'bthome-crypto', 'sensor-profiles', 'apple-continuity', 'nespresso-protocol', 'vesync-protocol', 'samsung-protocol', 'lg-webos-protocol', 'resmed-fig', 'beacon-protocol', 'bose-protocol', 'device-apps', 'profiles', 'device-library', 'scan-store', 'scan-query',
  'metadata', 'gatt-values', 'analysis', 'console', 'traffic', 'serial-codec', 'serial-wire', 'serial', 'api', 'advertisement', 'scan-stream', 'lab', 'connection', 'pocket-protocol', 'plaud-crypto',
  'plaud-protocol', 'credentials', 'credentials-ui', 'pocket', 'plaud', 'sleep-number-protocol', 'sleep-number', 'browser-cache',
  'sleep-mcr-protocol', 'sleep-mcr', 'sleep-router', 'radiacode-protocol', 'radiacode', 'dexcom-crypto', 'dexcom-protocol', 'dexcom-commands', 'dexcom-transport', 'dexcom-session',
  'dexcom-storage', 'dexcom-view', 'dexcom',
  'browser-ui', 'insights', 'workspace', 'settings', 'inspector', 'network-ui', 'usb-mode', 'collection', 'theme', 'device-support', 'protocol-app', 'beacon-app', 'sensor-history', 'sensor-session', 'sensor-app', 'modules',
  'pairing-catalog', 'pairing-model', 'pairing', 'device-page',
  'recipe-model', 'recipe-library', 'recipe-browser', 'recipes', 'snapshot-model', 'snapshots', 'guide', 'pwa', 'access-ui', 'api-ui', 'metadata-ui', 'catalog-ui', 'activity-led-ui', 'app',
];
const styles = ['style', 'lab', 'pocket', 'plaud', 'workspace', 'insights', 'network', 'snapshots', 'analysis', 'shell', 'device-page', 'radiacode', 'dexcom', 'credentials', 'usb-mode', 'pwa', 'collection', 'api-ui', 'module-layout', 'protocol-app', 'sensor-app', 'catalogs', 'settings'];
const concatenate = async (names, extension, separator) => (await Promise.all(
  names.map(name => readFile(`${web}${name}.${extension}`, 'utf8'))
)).join(separator);
const [javascript, css] = await Promise.all([
  concatenate(scripts, 'js', '\n;\n'), concatenate(styles, 'css', '\n'),
]);
const [scriptBundle, styleBundle] = await Promise.all([
  transform(javascript, { loader: 'js', minify: true, target: 'es2020', legalComments: 'inline', charset: 'utf8' }),
  transform(css, { loader: 'css', minify: true, legalComments: 'inline', charset: 'utf8' }),
]);
await Promise.all([
  writeFile(`${web}app.bundle.js`, scriptBundle.code),
  writeFile(`${web}app.bundle.css`, styleBundle.code),
]);
console.log(`app.bundle.js: ${Buffer.byteLength(scriptBundle.code)} bytes; app.bundle.css: ${Buffer.byteLength(styleBundle.code)} bytes`);
