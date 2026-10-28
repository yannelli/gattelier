'use strict';

const NanoDexcomSession = (() => {
  function create(lab, options = {}) {
    const p = typeof NanoDexcomProtocol !== 'undefined' ? NanoDexcomProtocol : require('./dexcom-protocol.js');
    const c = typeof NanoDexcomCommands !== 'undefined' ? NanoDexcomCommands : require('./dexcom-commands.js');
    const transportModule = typeof NanoDexcomTransport !== 'undefined' ? NanoDexcomTransport : require('./dexcom-transport.js');
    const acquisitionModule = typeof NanoDexcomAcquisition !== 'undefined' ? NanoDexcomAcquisition : require('./dexcom-acquisition.js');
    const now = options.now || Date.now;
    let device = null, store = null, key = null, jpake = null, generation = 0, busy = false, authenticated = false, destroyed = false;
    let status = 'idle', stage = '', error = '', reconnectAttempt = 0, reconnect = false, remember = false;
    let sessionTime = null, historyWindow = null, historyReceived = 0, pendingBond = null, finished = Promise.resolve(), release = null, acquisition, connecting = false;
    const crypto = () => options.crypto || globalThis.NanoDexcomCrypto;
    const bondMarker = bytes => ['0619', 'ff0601', '0600', '0601'].includes(p.hex(bytes));
    function snapshot() {
      return { ...(store?.snapshot() || { records: [], latest: null, identity: null, estimatedStart: null, packets: 0 }),
        device: device ? { ...device } : null, busy, authenticated, status, stage, error, reconnectAttempt, reconnect,
        sessionTime, historyWindow, historyReceived, acquisition: acquisition?.snapshot(), peerCertificateVerified: false };
    }
    function changed(next, step = stage) { if (next) status = next; stage = step; options.onChange?.(snapshot()); }
    function checkWindow(token) { if (destroyed || generation !== token) throw new Error('Dexcom operation cancelled.'); acquisition.guard(); }
    function check(token) { checkWindow(token); transport.guard(); }
    function eraseKey() { key?.fill(0); key = null; jpake?.destroy(); jpake = null; }
    function scheduleReconnect() {
      if (!reconnect || destroyed || !key || busy || !acquisition.snapshot().active) return;
      reconnectAttempt++;
      connect(device, { sessionKey: p.hex(key), remember, reconnect: true, retry: true }).catch(() => {});
    }
    function failed(reason) {
      if (!device || destroyed) return;
      authenticated = false; pendingBond?.reject(reason); pendingBond = null;
      if (busy) return;
      if (acquisition.transient(reason) && reconnect && acquisition.snapshot().active) scheduleReconnect();
      else { error = reason.message; acquisition.close(reason.message); changed('error', reason.message); }
    }
    function expired(reason) {
      const completed = authenticated;
      cancel().catch(() => {});
      error = completed && /window ended/.test(reason.message) ? '' : reason.message;
      changed(error ? 'error' : 'complete', reason.message);
    }
    acquisition = acquisitionModule.create(lab, { ...options, now, onChange: () => changed(), onExpire: expired });
    function receive(packet) {
      if (!authenticated || packet.channel !== 'control' && packet.channel !== 'backfill') return;
      try {
        const result = store.add(packet.event.uuid, packet.data, { receivedAt: packet.receivedAt });
        if (result.kind === 'history') historyReceived += result.records.length;
        if (result.kind === 'time') sessionTime = result;
        options.onReading?.(result, snapshot()); changed();
      } catch (reason) { failed(reason); transport.stop(); }
    }
    const transport = transportModule.create(lab, { ...options, now, onFailure: failed, onPacket: receive,
      setFastCapture: enabled => lab.setFastCapture?.(enabled || acquisition.snapshot().active) });
    const offState = lab.onState(state => {
      if (pendingBond && state.security?.bonded && state.security?.encrypted && acquisition.same(state.ble, device)) { pendingBond.resolve(); pendingBond = null; }
    });
    async function exchange(channel, bytes, accepts) {
      transport.clear(channel); const reply = transport.wait(channel, accepts);
      try { await transport.write(channel, bytes); return await reply; }
      catch (reason) { reply.catch(() => {}); throw reason; }
    }
    async function pair(token) {
      if (transport.state().security?.bonded && transport.state().security?.encrypted) return;
      changed('authenticating', 'Establishing the board BLE bond');
      const secured = new Promise((resolve, reject) => { pendingBond = { resolve, reject }; }); secured.catch(() => {});
      const timer = setTimeout(() => { pendingBond?.reject(new Error('Dexcom BLE bonding timed out. Check Security for a pairing prompt.')); pendingBond = null; }, options.bondTimeoutMs ?? 45000);
      try { await lab.action('pair'); check(token); if (transport.state().security?.bonded && transport.state().security?.encrypted) { pendingBond?.resolve(); pendingBond = null; } await secured; check(token); }
      finally { clearTimeout(timer); pendingBond = null; }
    }
    async function firstPair(pin, token) {
      if (!/^\d{4}$/.test(pin || '')) throw new Error('Enter the four ASCII digits printed on the G7 applicator.');
      jpake = crypto().createJpake(pin);
      for (let round = 1; round <= 3; round++) {
        changed('authenticating', `Verifying G7 key exchange ${round} of 3`);
        transport.clear('extra'); const peer = transport.collect('extra', 160); peer.catch(() => {});
        await transport.write('auth', Uint8Array.of(0x0a, round - 1));
        const bytes = await peer; check(token); jpake.acceptPeerRound(round, bytes);
        await transport.sendExtra(round === 1 ? jpake.round1() : round === 2 ? jpake.round2() : jpake.round3()); check(token);
      }
      key = jpake.deriveKey(); jpake.destroy(); jpake = null;
    }
    async function certificates(token) {
      const certs = crypto().certificates();
      for (let index = 0; index < 2; index++) {
        changed('authenticating', `Exchanging G7 certificate ${index + 1} of 2`); transport.clear('extra');
        const response = await exchange('auth', c.certificate(index, certs[index].length), bytes => bytes[0] === 0x0b || bytes[0] === 0xff);
        const length = c.certificateSize(response.data, index); await transport.collect('extra', length); check(token);
        await transport.sendExtra(certs[index]); check(token);
      }
      changed('authenticating', 'Answering G7 certificate challenge'); transport.clear('extra');
      const random = Uint8Array.of(...crypto().randomToken(), ...crypto().randomToken());
      const response = await exchange('auth', Uint8Array.of(0x0c, ...random), bytes => bytes[0] === 0x0c || bytes[0] === 0xff);
      if (response.data.length !== 18 || response.data[0] !== 0x0c || response.data[1] !== 0) throw new Error('G7 certificate challenge was rejected or malformed.');
      await transport.collect('extra', 64); check(token);
      await transport.sendExtra(crypto().signCertificateChallenge(response.data)); check(token);
      const completed = await exchange('auth', Uint8Array.of(0x0d, 0, 2), () => true); check(token);
      if (completed.data[0] === 0xff && !bondMarker(completed.data) || completed.data[0] === 5 && completed.data[1] !== 1) throw new Error('G7 rejected the certificate exchange.');
      const bondSignal = bondMarker(completed.data) ? Promise.resolve() : transport.wait('auth', bondMarker);
      await transport.write('auth', Uint8Array.of(6, 0x19));
      await bondSignal; check(token); await pair(token);
    }
    async function authenticate(token) {
      changed('authenticating', 'Verifying the G7 session challenge');
      const random = crypto().randomToken();
      const response = await exchange('auth', Uint8Array.of(2, ...random, 2), bytes => bytes[0] === 3 || bytes[0] === 0xff);
      check(token);
      if (response.data.length !== 17 || response.data[0] !== 3) throw new Error('G7 authentication challenge was rejected or malformed.');
      const expected = crypto().aes8(key, random); let mismatch = 0;
      for (let index = 0; index < 8; index++) mismatch |= expected[index] ^ response.data[index + 1];
      if (mismatch) throw new Error('G7 session challenge verification failed. Re-enter the applicator code to pair again.');
      const answer = crypto().aes8(key, response.data.slice(9, 17));
      const result = await exchange('auth', Uint8Array.of(4, ...answer), bytes => bytes[0] === 5 || bytes[0] === 0xff); check(token);
      if (result.data.length !== 3 || result.data[0] !== 5 || result.data[1] > 1 || result.data[2] > 2) throw new Error('G7 rejected application authentication.');
      if (result.data[1] === 1 && (result.data[2] === 1 || result.data[2] === 2 && transport.state().security?.bonded)) await pair(token);
      else await certificates(token);
    }
    async function control(kind) {
      if (!authenticated) throw new Error('Authenticate the selected G7 sensor first.');
      const bytes = kind === 'identity' ? c.identity() : c.current(), opcode = kind === 'identity' ? 0x4a : 0x4e;
      return exchange('control', bytes, value => value[0] === opcode);
    }
    async function connect(next, settings = {}) {
      if (destroyed) throw new Error('Dexcom reader is closed.');
      if (busy) throw new Error('A Dexcom operation is already running.');
      if (!next?.address) throw new Error('Select a G7 sensor first.');
      if (!crypto()) throw new Error('G7 cryptography is unavailable.');
      if (settings.pin && !/^\d{4}$/.test(settings.pin)) throw new Error('Enter the four ASCII digits printed on the G7 applicator.');
      if (!settings.retry) acquisition.open(next);
      const same = acquisition.same(device, next);
      if (!same) { eraseKey(); store = p.createStore(next); sessionTime = null; }
      device = { ...next }; store ||= p.createStore(device); remember = settings.remember === true; reconnect = settings.reconnect !== false;
      if (!settings.retry) reconnectAttempt = 0;
      const token = ++generation; busy = true; authenticated = false; error = ''; changed('waiting', 'Waiting for a matching G7 advertisement');
      finished = new Promise(resolve => { release = resolve; });
      try {
        const saved = settings.sessionKey || (!settings.pin && (key ? p.hex(key) : (await acquisition.until(options.loadSession?.(device)))?.key));
        checkWindow(token);
        if (saved && !settings.pin) { const value = p.bytes(saved); if (value.length !== 16) throw new Error('Saved G7 session key must contain 16 bytes.'); eraseKey(); key = value.slice(); }
        else if (!settings.pin) throw new Error('Enter the four ASCII digits printed on the G7 applicator.');
        let reuse = !settings.retry;
        while (true) {
          await acquisition.next(reuse); checkWindow(token); reuse = false;
          acquisition.attempted(); changed('connecting', 'Connecting to the observed G7');
          try {
            if (!lab.getState().ble?.connected) {
              connecting = true;
              const target = { ...device }, pending = lab.action('connect', { address: device.address.toLowerCase(), addressType: device.addressType });
              pending.then(async result => {
                if (generation !== token && !acquisition.snapshot().active && acquisition.same(result.ble, target) && acquisition.same(lab.getState().ble, target) && lab.getState().ble?.connectionAttempt === result.ble.connectionAttempt) { await lab.action('disconnect'); await acquisition.releaseScan(); }
              }).catch(() => {});
              try { await acquisition.until(pending); } finally { connecting = false; }
            }
            checkWindow(token);
            if (!lab.getState().ble?.connected || !acquisition.same(lab.getState().ble, device)) throw new Error(lab.getState().ble?.error || 'The device did not establish a connection. Try again.');
            await transport.begin(device); check(token);
            await transport.subscribe('extra', 'notify'); await transport.subscribe('auth', 'indicate'); check(token);
            if (settings.pin) { eraseKey(); await firstPair(settings.pin, token); }
            await authenticate(token); check(token); authenticated = true;
            if (remember) await options.saveSession?.(device, { key: p.hex(key) }); check(token);
            await transport.subscribe('backfill', 'notify'); await transport.subscribe('control', 'notify'); check(token);
            changed('connected', 'Reading current glucose'); await control('latest'); check(token);
            acquisition.result('Authenticated; latest reading received'); changed('connected', 'Receiving G7 readings');
            return snapshot();
          } catch (reason) {
            if (generation !== token || !acquisition.snapshot().active || !acquisition.transient(reason)) throw reason;
            authenticated = false; transport.stop(); jpake?.destroy(); jpake = null;
            const state = lab.getState();
            if (state.ble?.connected && acquisition.same(state.ble, device)) await lab.action('disconnect');
            checkWindow(token); acquisition.result(reason.message); changed('waiting', 'Connection missed; waiting for the next matching advertisement');
          }
        }
      } catch (reason) {
        if (generation === token) { authenticated = false; error = reason.message; acquisition.close(reason.message); transport.stop(); changed('error', reason.message); }
        throw reason;
      } finally { busy = false; release?.(); release = null; changed(); }
    }
    async function run(operation) {
      if (busy) throw new Error('A Dexcom operation is already running.');
      const token = generation; busy = true; changed();
      finished = new Promise(resolve => { release = resolve; });
      try { const result = await operation(); check(token); return result; }
      catch (reason) { if (generation === token) { error = reason.message; changed('error', error); } throw reason; }
      finally { busy = false; release?.(); release = null; changed(); if (!authenticated && !error) scheduleReconnect(); }
    }
    async function readHistory({ hours = 3 } = {}) {
      return run(async () => {
        if (!authenticated) throw new Error('Authenticate the selected G7 sensor first.');
        const latest = store.snapshot().latest;
        const request = c.history(latest?.clock, hours); historyWindow = { start: request.start, end: request.end }; historyReceived = 0;
        transport.clear('control'); transport.clear('backfill'); changed('connected', 'Reading bounded G7 history');
        const complete = transport.wait('control', bytes => bytes[0] === 0x59, options.historyTimeoutMs ?? 30000);
        await transport.write('control', request.bytes); await complete;
        changed('connected', 'G7 history transfer ended'); return snapshot();
      });
    }
    function cancel() {
      reconnect = false; const closed = acquisition.close(); generation++; authenticated = false; error = '';
      const cancelledGeneration = generation, cancelledDevice = device ? { ...device } : null, cancelledAttempt = lab.getState().ble?.connectionAttempt;
      pendingBond?.reject(new Error('Dexcom session cancelled.')); pendingBond = null; transport.stop(); jpake?.destroy(); jpake = null;
      if (busy && device && (connecting || ['connecting', 'discovering'].includes(lab.getState().ble?.operation))) Promise.resolve(lab.action('cancel-connect', { address: device.address.toLowerCase(), addressType: device.addressType })).catch(() => {});
      changed('idle', 'Session stopped');
      return Promise.all([finished, closed]).then(async () => {
        const state = lab.getState();
        if (generation === cancelledGeneration && state.ble?.connectionAttempt === cancelledAttempt && state.ble?.connected && acquisition.same(state.ble, cancelledDevice)) await lab.action('disconnect');
        if (generation === cancelledGeneration) await acquisition.releaseScan();
      }).catch(() => {});
    }
    async function disconnect() {
      await cancel();
      const state = lab.getState();
      if (state.ble?.connected && acquisition.same(state.ble, device)) await lab.action('disconnect');
      return snapshot();
    }
    return { connect, readLatest: () => run(async () => { await control('latest'); return snapshot(); }), readIdentity: () => run(async () => { await control('identity'); return snapshot(); }),
      readTime: () => Promise.reject(new Error('The G7 protocol has no direct time query.')), readHistory, cancel, disconnect, snapshot, captureSnapshot: () => acquisition.captureSnapshot(), pollAcquisition: () => acquisition.poll(),
      async forgetSession() { cancel(); eraseKey(); await options.forgetSession?.(device); },
      destroy() { cancel(); destroyed = true; eraseKey(); transport.destroy(); acquisition.destroy(); offState?.(); } };
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomSession;
