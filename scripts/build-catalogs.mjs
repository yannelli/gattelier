import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import schema from '../web/catalog-schema.js';

export async function buildCatalogs(root, destination) {
  const ids = ['bluetooth-uuids', 'bluetooth-appearance', 'bluetooth-ad-types', 'protocol-signatures', 'vendor-uuids'];
  const hash = createHash('sha256'), libraries = [], files = [];
  for (const id of ids) {
    const bytes = await readFile(`${root}/catalogs/${id}.json`), catalog = schema.validate(JSON.parse(bytes));
    if (catalog.id !== id) throw new Error(`Catalog ID mismatch: ${id}`);
    hash.update(id).update(bytes);
    libraries.push({ id, kind: catalog.kind, title: catalog.title, revision: catalog.revision, path: `/catalogs/${id}.json`, count: catalog.entries.length, bytes: bytes.length });
    files.push({ id, bytes });
  }
  const manifest = schema.manifest({ schema: 1, revision: hash.digest('hex'), libraries });
  await mkdir(`${destination}/catalogs`, { recursive: true });
  await Promise.all(files.map(({ id, bytes }) => writeFile(`${destination}/catalogs/${id}.json`, bytes)));
  await writeFile(`${destination}/catalogs/index.json`, JSON.stringify(manifest));
  return manifest;
}
