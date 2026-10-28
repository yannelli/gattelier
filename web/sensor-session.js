'use strict';

const NanoSensorSession = (() => {
  const profiles = typeof module !== 'undefined' ? require('./sensor-profiles.js') : NanoSensorProfiles;
  const keyOf = device => device ? `${device.address.toLowerCase()}/${device.addressType}` : '';
  const frame = device => JSON.stringify([device.manufacturer, device.serviceData]);
  const encrypted = profile => profile?.protocol === 'bthome' && profile.fields.some(field => field.label === 'Encryption' && field.value === 'Encrypted');
  function create(history, options = {}) {
    const decoder = options.decode || profiles.identifyDecrypted;
    let device = null, profile = null, secret = '', generation = 0, pending = false, seen = '', message = '', recording = true;
    let counter = null, acceptedFrame = '', requiresEncryption = false;
    const change = () => options.change?.();
    function status() { return { device, profile, pending, recording, hasKey: Boolean(secret), encrypted: requiresEncryption || encrypted(profiles.identify(device)), message }; }
    function lock() { generation++; pending = false; secret = ''; seen = ''; message = ''; profile = requiresEncryption && !encrypted(profiles.identify(device)) ? null : profiles.identify(device); change(); }
    async function observe(next, force = false) {
      if (!next || keyOf(next) !== keyOf(device)) return;
      device = next;
      const signature = `${next.lastSeenMs}/${frame(next)}`;
      if (pending || !force && seen === signature) return;
      seen = signature; const version = generation;
      const plain = profiles.identify(next);
      if (!plain) { profile = null; change(); return; }
      message = '';
      if (encrypted(plain)) requiresEncryption = true;
      if (requiresEncryption && !encrypted(plain)) { profile = null; message = 'Unencrypted frame ignored for this encrypted sensor.'; change(); return; }
      let duplicate = false;
      if (encrypted(plain) && secret) {
        pending = true; change();
        try {
          const decoded = await decoder(next, secret);
          if (version !== generation) return;
          const currentFrame = frame(next);
          if (!decoded.authenticated || !Number.isSafeInteger(decoded.counter)) throw new Error('The sensor payload was not authenticated.');
          if (counter !== null && (decoded.counter < counter || decoded.counter === counter && currentFrame !== acceptedFrame)) throw new Error('An older or reused encryption counter was received. This reading was ignored.');
          duplicate = counter === decoded.counter;
          counter = decoded.counter; acceptedFrame = currentFrame; profile = decoded;
        } catch (error) { if (version !== generation) return; profile = plain; message = error.message; }
        finally { if (version === generation) pending = false; }
      } else profile = plain;
      if (version !== generation) return;
      if (recording && profile && !message && !duplicate && (!requiresEncryption || profile.authenticated)) history.ingest(next, profile);
      change();
      if (version === generation && seen !== `${device.lastSeenMs}/${frame(device)}`) return observe(device);
    }
    function select(next) {
      if (keyOf(next) !== keyOf(device)) { device = next; requiresEncryption = false; counter = null; acceptedFrame = ''; lock(); }
      return observe(next);
    }
    function unlock(value) {
      if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error('Enter the sensor’s 32-character HEX encryption key.');
      if (!device || !encrypted(profiles.identify(device))) throw new Error('Select an encrypted BTHome sensor.');
      lock(); counter = null; acceptedFrame = ''; secret = value; return observe(device, true);
    }
    function toggle() { recording = !recording; if (recording) { seen = ''; observe(device); } change(); }
    return { status, select, observe, unlock, lock, toggle };
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoSensorSession;
