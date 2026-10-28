import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { create, validate, maxBytes } = createRequire(import.meta.url)('../web/credentials.js');
const storageKey = 'nanoscope.credentials.v1';
const mac = 'aa:bb:cc:dd:ee:ff', otherMac = '12:34:56:78:90:ab', key = 'aBcd1234EFgh5678';
const plaud = {
  serial: '01020304AABBCCDD', userId: 'example',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----',
  signature: Buffer.alloc(256, 7).toString('base64')
};
const backup = records => ({ format: 'nanoscope-credentials', schemaVersion: 1, records });
const record = (id = mac, credentials = key) => ({ kind: 'pocket', id, credentials, updatedAt: 123 });
const file = value => { const content = JSON.stringify(value); return { size: Buffer.byteLength(content), text: async () => content }; };
function memoryStorage() {
  const values = new Map();
  return { values, getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) };
}

test('app JSON imports accept original PLAUD files and combined recorder backups', async () => {
  const saved = create({ storage: memoryStorage(), now: () => 456 });
  assert.equal((await saved.importFile(file(plaud))).imported, 1);
  assert.equal((await saved.importFile(file(backup([record()])))).imported, 1);
  assert.equal(saved.getPlaud(plaud.serial).signature, plaud.signature);
  assert.equal(saved.getPocket(mac), key);
  await assert.rejects(saved.importFile({ size: 1, text: async () => '{' }), /not valid JSON/);
  await assert.rejects(saved.importFile({ size: 512 * 1024 + 1, text: async () => '{}' }), /under 512 KiB/);
  assert.equal(saved.status().count, 2);
});

test('recorder credentials persist with their explicit identities and reload', () => {
  const storage = memoryStorage(), saved = create({ storage, now: () => 456 });
  assert.equal(saved.savePlaud(plaud).persistent, true);
  assert.equal(saved.savePocket(mac.toUpperCase(), key).persistent, true);
  const restored = create({ storage });
  assert.deepEqual(restored.getPlaud(plaud.serial), { ...plaud, serial: plaud.serial.toLowerCase() });
  assert.equal(restored.getPocket(mac), key);
  assert.equal(restored.getPocket(otherMac), null);
  assert.deepEqual(restored.status(), { count: 2, persistent: true, error: '' });
  assert.deepEqual(Object.keys(restored.list()[0]), ['kind', 'id', 'updatedAt']);
  assert.equal(JSON.stringify(restored.list()).includes(key), false);
  assert.equal(JSON.stringify(restored.list()).includes(plaud.privateKeyPem), false);
});

test('exports initialize from storage and return detached credential copies', () => {
  const storage = memoryStorage(), original = create({ storage });
  original.savePlaud(plaud); original.savePocket(mac, key);
  const reloaded = create({ storage }), exported = reloaded.exportData();
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.records.length, 2);
  exported.records[0].credentials.userId = 'changed';
  const credential = reloaded.getPlaud(plaud.serial); credential.userId = 'changed again';
  assert.equal(reloaded.getPlaud(plaud.serial).userId, plaud.userId);
  assert.equal(reloaded.exportData().records[1].credentials, key);
});

test('restore merges matching identities and preserves unrelated credentials', () => {
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.savePlaud(plaud); store.savePocket(mac, key);
  const replacement = '1234567890abcdef';
  const result = store.importData(backup([record(mac.toUpperCase(), replacement), record(otherMac)]));
  assert.deepEqual(result, { persistent: true, error: '', imported: 2, count: 3 });
  assert.equal(store.getPocket(mac), replacement);
  assert.equal(store.getPocket(otherMac), key);
  assert.equal(store.getPlaud(plaud.serial).signature, plaud.signature);
  store.remove('pocket', mac.toUpperCase());
  assert.equal(store.getPocket(mac), null);
  assert.equal(create({ storage: { getItem: () => JSON.stringify(store.exportData()) } }).getPocket(otherMac), key);
});

test('an invalid record rejects the whole restore without changing saved credentials', () => {
  const storage = memoryStorage(), store = create({ storage }); store.savePocket(mac, key);
  const saved = storage.getItem(storageKey);
  assert.throws(() => store.importData(backup([record(otherMac), record(mac, 'bad')])));
  assert.equal(store.getPocket(otherMac), null);
  assert.equal(store.getPocket(mac), key);
  assert.equal(storage.getItem(storageKey), saved);
});

test('validation rejects unknown schemas, fields, prototypes and duplicate identities', () => {
  const malformed = [
    { ...backup([]), schemaVersion: 2 }, { ...backup([]), format: 'other' },
    { ...backup([]), extra: 'field' }, { ...backup([]), exportedAt: Infinity },
    backup([{ ...record(), extra: 'field' }]), backup([{ ...record(), updatedAt: 1.5 }]),
    backup([record(), record(mac.toUpperCase())]),
    Object.assign(Object.create({ inherited: true }), backup([])),
    JSON.parse('{"format":"nanoscope-credentials","schemaVersion":1,"records":[],"__proto__":{"polluted":true}}')
  ];
  for (const value of malformed) assert.throws(() => validate(value));
  assert.equal(Object.prototype.polluted, undefined);
});

test('PLAUD restore validates serial, key material and signature without inventing identity', () => {
  const valid = { kind: 'plaud', id: plaud.serial, credentials: plaud, updatedAt: 0 };
  assert.equal(validate(backup([valid]))[0].id, plaud.serial.toLowerCase());
  const invalid = [
    { ...valid, id: '0000000000000000' },
    { ...valid, credentials: { ...plaud, privateKeyPem: 'bad' } },
    { ...valid, credentials: { ...plaud, signature: 'AQID' } },
    { ...valid, credentials: { ...plaud, userId: 'é' } },
    { ...valid, credentials: { ...plaud, serial: `${plaud.serial}\n` } },
    { ...valid, credentials: { ...plaud, unexpected: 'field' } },
    { ...valid, credentials: Object.assign(Object.create({ inherited: true }), plaud) }
  ];
  for (const value of invalid) assert.throws(() => validate(backup([value])));
});

test('credential size and record limits apply before a restore changes storage', () => {
  const store = create({ storage: memoryStorage() });
  assert.throws(() => store.savePlaud({ ...plaud, privateKeyPem: 'x'.repeat(32769) }));
  assert.throws(() => validate(backup(Array.from({ length: 101 }, () => record()))));
  assert.throws(() => validate({ ...backup([]), padding: 'x'.repeat(maxBytes) }));
  for (const [address, secret] of [['unknown', key], [`${mac}\n`, key], [mac, `${key}\n`], [mac, 'x'.repeat(17)], [mac, 'abcdefghijklmn é']]) {
    assert.throws(() => store.savePocket(address, secret));
  }
  assert.equal(store.status().count, 0);
});

test('merging beyond the total record limit leaves the existing store intact', () => {
  const store = create({ storage: memoryStorage() });
  const records = Array.from({ length: 100 }, (_, index) => record(`00:00:00:00:00:${index.toString(16).padStart(2, '0')}`));
  store.importData(backup(records));
  assert.throws(() => store.importData(backup([record(mac)])));
  assert.equal(store.status().count, 100);
  assert.equal(store.getPocket(mac), null);
});

test('failed browser persistence retains an exportable in-memory copy', () => {
  let events = 0;
  const store = create({ storage: { getItem: () => null, setItem: () => { throw new Error('Quota'); } }, onChange: () => events++ });
  const result = store.savePocket(mac, key);
  assert.equal(result.persistent, false);
  assert.match(result.error, /memory only/);
  assert.equal(store.getPocket(mac), key);
  assert.equal(store.exportData().records[0].credentials, key);
  assert.equal(events, 1);
});

test('invalid saved data is reported without replacing the browser value', () => {
  const storage = memoryStorage(); storage.setItem(storageKey, '{broken');
  const store = create({ storage });
  assert.equal(store.status().persistent, false);
  assert.equal(store.status().count, 0);
  assert.match(store.status().error, /could not be loaded/);
  assert.equal(storage.getItem(storageKey), '{broken');
  storage.setItem(storageKey, 'x'.repeat(maxBytes + 1));
  assert.equal(create({ storage }).status().persistent, false);
});

test('future imported timestamps are clamped to the local import time', () => {
  const store = create({ storage: memoryStorage(), now: () => 50 });
  store.importData(backup([record()]));
  assert.equal(store.list()[0].updatedAt, 50);
});
