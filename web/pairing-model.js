'use strict';

const NanoPairingModel = (() => {
  const statuses = { idle: 'Ready to pair', pairing: 'Pairing in progress', 'passkey-input': 'Enter the code shown by your device', 'numeric-comparison': 'Compare this code with your device', 'passkey-display': 'Enter this code on your device', secured: 'Connection secured', failed: 'Pairing failed', cancelled: 'Pairing cancelled' };
  function target(state, device) { return Boolean(device && state.ble?.connected && state.ble.addressType === device.addressType && state.ble.address.toLowerCase() === device.address.toLowerCase()); }
  function response(state, device, challengeId, value) {
    const security = state.security || {};
    if (!target(state, device) || !security.active || !challengeId || security.challengeId !== challengeId || security.address.toLowerCase() !== device.address.toLowerCase()) throw new Error('The pairing request changed. Use the current device prompt.');
    const result = { address: device.address, challengeId };
    if (security.status === 'passkey-input') {
      if (typeof value !== 'string' || !/^\d{6}$/.test(value)) throw new Error('Enter exactly six digits, including leading zeros.');
      result.passkey = value;
    } else if (security.status === 'numeric-comparison' && typeof value === 'boolean') result.accept = value;
    else throw new Error('This pairing request does not accept that response.');
    return result;
  }
  return { statuses, target, response };
})();
if (typeof module !== 'undefined') module.exports = NanoPairingModel;
