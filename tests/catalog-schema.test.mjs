import test from 'node:test';
import assert from 'node:assert/strict';
import schema from '../web/catalog-schema.js';
import { catalogs, rawCatalogs, fixture } from './catalog-fixtures.mjs';

const change = (index, edit) => { const value = structuredClone(rawCatalogs[index]); edit(value); return value; };
test('published catalogs validate and retain their coverage and provenance', () => {
  assert.deepEqual(catalogs.map(item => item.entries.length), [1484, 342, 51, 36, 250]);
  assert.equal(catalogs[0].entries.filter(item => item.kind === 'member-service').length, 724);
  assert.match(catalogs[0].revision, /^sig\.[0-9a-f]{40}$/);
  assert.equal(catalogs[2].entries.filter(item => item.code === 16).length, 2);
  for (const catalog of catalogs) for (const entry of catalog.entries) assert.ok(entry.source || entry.sources.length);
});
test('schema rejects executable rules, invalid ranges, malformed UUIDs and source URLs', () => {
  for (const edit of [
    value => value.entries[0].rules[0][0] = { kind: 'regex', value: '.*' },
    value => value.entries[0].rules[0][0] = { kind: 'manufacturer-prefix', hex: '01' },
    value => value.entries[0].rules[0][0] = { kind: 'service-data', uuid: '180d', minBytes: 8, maxBytes: 2 },
    value => value.entries[0].rules[0][0] = { kind: 'manufacturer-prefix', hex: '010203', maxBytes: 2 },
    value => value.entries[0].rules[0][0] = { kind: 'service', uuid: '1bad-script' },
    value => value.entries[0].sources[0].url = 'javascript:alert(1)',
    value => value.entries[0].sources[0].url = 'https://user:password@example.com',
    value => value.entries[0].title = 'bad\nlabel',
    value => value.entries[0].rules = Array.from({ length: 9 }, () => [{ kind: 'service', uuid: '180d' }])
  ]) assert.throws(() => schema.validate(change(3, edit)), /Invalid library/);
});
test('unknown JSON properties are discarded and duplicate identifiers are rejected', () => {
  const cleaned = schema.validate(change(3, value => { value.entries[0].script = 'alert(1)'; value.entries[0].rules[0][0].evaluate = 'evil'; }));
  assert.equal(cleaned.entries[0].script, undefined);
  assert.equal(cleaned.entries[0].rules[0][0].evaluate, undefined);
  for (let index = 0; index < 5; index++) assert.throws(() => schema.validate(change(index, value => value.entries.push(value.entries[0]))), /duplicate/);
  assert.throws(() => schema.validate(change(1, value => value.entries[1].code = 65536)), /numeric code/);
  assert.throws(() => schema.validate(change(1, value => value.entries[1].subcategory = 63)), /appearance code/);
});
test('manifest fixes catalog paths and bounds count and size', () => {
  const index = fixture().index;
  assert.equal(schema.manifest(index).libraries.length, 5);
  for (const edit of [
    value => value.libraries[0].path = 'https://elsewhere.example/collect',
    value => value.libraries[0].path = '/catalogs/../secret.json',
    value => value.libraries[0].bytes = 2 * 1024 * 1024 + 1,
    value => value.libraries[0].count = 0,
    value => value.libraries.push(value.libraries[0])
  ]) { const value = structuredClone(index); edit(value); assert.throws(() => schema.manifest(value), /Invalid library/); }
});
