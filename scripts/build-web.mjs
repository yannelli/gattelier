import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const scripts = [
  'vendors', 'packets', 'pklg', 'recorders', 'sensor-profiles', 'profiles', 'device-library', 'scan-store', 'scan-query',
  'metadata', 'gatt-values', 'analysis', 'console', 'traffic', 'api', 'scan-stream', 'lab', 'connection', 'pocket-protocol', 'plaud-crypto',
  'plaud-protocol', 'credentials', 'credentials-ui', 'pocket', 'plaud', 'sleep-number-protocol', 'sleep-number', 'browser-cache',
  'sleep-mcr-protocol', 'sleep-mcr', 'sleep-router', 'radiacode-protocol', 'radiacode', 'dexcom-crypto', 'dexcom-protocol', 'dexcom-commands', 'dexcom-transport', 'dexcom-session',
  'dexcom-storage', 'dexcom-view', 'dexcom',
  'browser-ui', 'insights', 'workspace', 'inspector', 'network-ui', 'usb-mode', 'collection', 'theme', 'device-support', 'modules',
  'pairing-catalog', 'pairing-model', 'pairing', 'device-page',
  'recipe-model', 'recipe-library', 'recipe-browser', 'recipes', 'snapshot-model', 'snapshots', 'guide', 'pwa', 'access-ui', 'api-ui', 'metadata-ui', 'activity-led-ui', 'app',
];
const styles = ['style', 'lab', 'pocket', 'plaud', 'workspace', 'insights', 'network', 'snapshots', 'analysis', 'shell', 'device-page', 'radiacode', 'dexcom', 'credentials', 'usb-mode', 'pwa', 'collection', 'api-ui', 'module-layout'];
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
