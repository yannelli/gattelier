import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const require = createRequire(new URL('../web/app.js', import.meta.url));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
  const actions = [], requests = [];
  const context = vm.createContext({ module: { exports: {} }, require,
    NanoLab: { action(action, data) { const result = deferred(); actions.push({ action, data, ...result }); return result.promise; } },
    refresh: () => requests.push('state')
  });
  vm.runInContext(source, context);
  vm.runInContext('online=true; state.ble={busy:false}; render=()=>{}; poll=async()=>refresh();', context);
  return { actions, requests, run: expression => vm.runInContext(expression, context),
    start: handle => vm.runInContext(`mutate('read',{handle:${handle}})`, context),
    change() { vm.runInContext('apiGeneration++; pending=false; notice="Current board notice.";', context); },
    state: () => vm.runInContext('({pending,notice})', context)
  };
}

test('completed command refreshes and releases the same board normally', async () => {
  const f = fixture(), operation = f.start(3);
  assert.equal(f.state().pending, true); f.actions[0].resolve(); await operation;
  assert.equal(f.state().pending, false); assert.deepEqual(f.requests, ['state']);
});

test('late command success and failure cannot release a newer board operation', async () => {
  for (const fail of [false, true]) {
    const f = fixture(), old = f.start(3); f.change(); const current = f.start(5);
    if (fail) f.actions[0].reject(new Error('Old board failure.')); else f.actions[0].resolve();
    await old;
    assert.equal(f.state().pending, true); assert.equal(f.state().notice, '');
    assert.deepEqual(f.requests, []);
    f.actions[1].resolve(); await current;
    assert.equal(f.state().pending, false); assert.deepEqual(f.requests, ['state']);
  }
});

test('late command error leaves a notice on the selected board intact', async () => {
  const f = fixture(), operation = f.start(3); f.change();
  f.actions[0].reject(new Error('Old board failure.')); await operation;
  assert.equal(f.state().notice, 'Current board notice.'); assert.deepEqual(f.requests, []);
});

test('board change while waiting for a state poll prevents another refresh', async () => {
  const f = fixture();
  f.run('pollPromise = new Promise(resolve => globalThis.finishPoll = resolve);');
  const operation = f.start(3); f.actions[0].resolve();
  await Promise.resolve(); f.change();
  f.run('finishPoll();'); await operation;
  assert.deepEqual(f.requests, []); assert.equal(f.state().notice, 'Current board notice.');
});

test('current board errors stay visible and release the operation', async () => {
  for (const timeout of [false, true]) {
    const f = fixture(), operation = f.start(3), error = new Error('Current read failed.');
    if (timeout) error.name = 'AbortError';
    f.actions[0].reject(error); await operation;
    assert.equal(f.state().pending, false);
    assert.match(f.state().notice, timeout ? /request timed out/ : /Current read failed/);
  }
});
