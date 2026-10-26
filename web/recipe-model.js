'use strict';

const NanoRecipeModel = (() => {
  const actions = ['read', 'write', 'subscribe', 'wait'];
  const fields = { read: [], write: ['hex', 'response'], subscribe: ['mode'], wait: ['prefix'] };
  const example = { version: 1, name: 'Read battery', steps: [{ action: 'read', service: '180f', uuid: '2a19' }] };
  function uuid(value) {
    if (typeof value !== 'string') throw new Error('Provide a characteristic or service UUID.');
    value = value.toLowerCase();
    if (/^(?:0x)?[0-9a-f]{4}$/.test(value)) return `0000${value.replace(/^0x/, '')}-0000-1000-8000-00805f9b34fb`;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Use a 16-bit or complete 128-bit UUID.');
    return value;
  }
  function object(value, label, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length) throw new Error(`${label} has unsupported fields: ${unknown.join(', ')}.`);
  }
  function hex(value, label) {
    if (typeof value !== 'string' || value.length > 1024 || value.length % 2 || !/^[0-9a-f]*$/i.test(value)) throw new Error(`${label} must contain complete HEX bytes, up to 512 bytes.`);
    return value.toLowerCase();
  }
  function validate(input) {
    if (new TextEncoder().encode(JSON.stringify(input)).length > 65536) throw new Error('Recipe exceeds 64 KiB.');
    object(input, 'Recipe', ['version', 'name', 'address', 'steps']);
    if (input.version !== 1) throw new Error('Recipe version must be 1.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new Error('Recipe name must contain 1 to 80 characters.');
    if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 32) throw new Error('A recipe requires 1 to 32 steps.');
    const result = { version: 1, name: input.name.trim() };
    if (input.address !== undefined) {
      if (typeof input.address !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(input.address)) throw new Error('Target address must be a Bluetooth MAC address.');
      result.address = input.address.toLowerCase();
    }
    result.steps = input.steps.map((step, index) => {
      object(step, `Step ${index + 1}`, ['action', 'service', 'uuid', 'instance', 'timeoutMs', ...(Object.hasOwn(fields, step?.action) ? fields[step.action] : [])]);
      if (!actions.includes(step.action)) throw new Error(`Step ${index + 1} has an unsupported action.`);
      const normalized = { action: step.action, uuid: uuid(step.uuid) };
      if (step.service !== undefined) normalized.service = uuid(step.service);
      if (step.instance !== undefined) {
        if (!normalized.service || !Number.isInteger(step.instance) || step.instance < 0 || step.instance > 65535) throw new Error('Instance requires a service UUID and a zero-based integer.');
        normalized.instance = step.instance;
      }
      normalized.timeoutMs = step.timeoutMs ?? 10000;
      if (!Number.isInteger(normalized.timeoutMs) || normalized.timeoutMs < 100 || normalized.timeoutMs > 30000) throw new Error('Step timeoutMs must be an integer from 100 to 30000.');
      if (step.action === 'write') {
        normalized.hex = hex(step.hex, 'Write payload'); normalized.response = step.response ?? true;
        if (typeof normalized.response !== 'boolean') throw new Error('Write response must be true or false.');
      }
      if (step.action === 'subscribe') {
        normalized.mode = step.mode ?? 'notify';
        if (!['notify', 'indicate', 'off'].includes(normalized.mode)) throw new Error('Subscription mode must be notify, indicate, or off.');
      }
      if (step.action === 'wait') normalized.prefix = hex(step.prefix ?? '', 'Reply prefix');
      return normalized;
    });
    return result;
  }
  function resolve(state, step) {
    if (!state.ble?.connected) throw new Error('Connect a device before running a recipe.');
    const all = (state.services || []).flatMap(service => (service.characteristics || []).map(characteristic => ({ service, characteristic })))
      .filter(item => uuid(item.characteristic.uuid) === uuid(step.uuid));
    if (all.length > 1 && (!step.service || step.instance === undefined)) throw new Error('Characteristic UUID is ambiguous. Specify service and instance.');
    const candidates = all.filter(item => !step.service || uuid(item.service.uuid) === uuid(step.service)).sort((a, b) => a.characteristic.handle - b.characteristic.handle);
    const match = candidates[step.instance ?? 0]?.characteristic;
    if (!match || !Number.isInteger(match.handle) || match.handle < 1) throw new Error('Recipe characteristic is unavailable on this connection.');
    const properties = match.properties || [];
    const required = step.action === 'write' ? [step.response ? 'write' : 'write-no-response'] : step.action === 'read' ? ['read'] : step.action === 'subscribe' && step.mode !== 'off' ? [step.mode] : ['notify', 'indicate'];
    if (!required.some(property => properties.includes(property))) throw new Error(`Characteristic does not support ${step.action}${step.mode ? ` ${step.mode}` : ''}.`);
    if (step.action === 'write' && !step.response && step.hex.length / 2 > Math.max(0, (state.ble.mtu || 23) - 3)) throw new Error('Write without response exceeds the negotiated MTU.');
    return match;
  }
  function canStore(recipe, sensitive) {
    return recipe.steps.every(step => !sensitive(step.hex || '', step.uuid) && !sensitive(step.prefix || '', step.uuid));
  }
  return { validate, resolve, uuid, canStore, example: () => JSON.parse(JSON.stringify(example)) };
})();
if (typeof module !== 'undefined') module.exports = NanoRecipeModel;
