import { readFile } from 'node:fs/promises';
import schema from '../web/catalog-schema.js';

export const ids = ['bluetooth-uuids', 'bluetooth-appearance', 'bluetooth-ad-types', 'protocol-signatures', 'vendor-uuids'];
export const rawCatalogs = await Promise.all(ids.map(async id => JSON.parse(await readFile(new URL(`../catalogs/${id}.json`, import.meta.url), 'utf8'))));
export const catalogs = rawCatalogs.map(schema.validate);
export function fixture(overrides = {}) {
  const bodies = new Map(rawCatalogs.map(catalog => [`/catalogs/${catalog.id}.json`, JSON.stringify(catalog)]));
  const index = { schema: 1, revision: 'fixture.1', libraries: catalogs.map(catalog => ({ id: catalog.id, title: catalog.title, kind: catalog.kind, revision: catalog.revision, count: catalog.entries.length, bytes: Buffer.byteLength(bodies.get(`/catalogs/${catalog.id}.json`)), path: `/catalogs/${catalog.id}.json` })) };
  bodies.set('/catalogs/index.json', JSON.stringify(index));
  const calls = [], saves = []; let saved;
  return {
    bodies, index, calls, saves,
    storage: { load: async () => saved, save: async value => { saved = structuredClone(value); saves.push(saved); } },
    fetcher: async (url, options) => { calls.push({ url, options }); const body = bodies.get(new URL(url).pathname); return new Response(body, { status: body ? 200 : 404 }); },
    now: () => 1700000000000,
    ...overrides
  };
}
