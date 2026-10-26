'use strict';

const NanoAppleContinuity = (() => {
  const research = 'https://github.com/furiousMAC/continuity/blob/d9fa98bddafbfa3baafc84e37a417d78a0598546/messages/';
  const libre = 'https://github.com/kavishdevar/librepods/blob/89356c08cea3db0b6b54792d9329d09a87cc85fa/android/app/src/main/java/me/kavishdevar/librepods/bluetooth/';
  const sources = [{ title: 'Continuity message formats', url: research + '../README.md' }, { title: 'LibrePods advertisement decoder', url: libre + 'BLEManager.kt' }, { title: 'LibrePods control framing', url: libre + 'AACPManager.kt' }];
  const models = { '0220': 'AirPods 1', '0f20': 'AirPods 2', '1320': 'AirPods 3', '1920': 'AirPods 4', '1b20': 'AirPods 4 (ANC)', '0e20': 'AirPods Pro', '1420': 'AirPods Pro 2', '2420': 'AirPods Pro 2 (USB-C)', '0a20': 'AirPods Max', '1f20': 'AirPods Max (USB-C)', '0520': 'BeatsX', '0620': 'Beats Solo3', '0920': 'Beats Studio3', '0b20': 'Powerbeats Pro', '0c20': 'Beats Solo Pro', '1020': 'Beats Flex', '1120': 'Beats Studio Buds', '0320': 'Powerbeats3' };
  const types = { 2: 'iBeacon', 3: 'AirPrint', 5: 'AirDrop', 6: 'HomeKit', 7: 'Headphone proximity', 8: 'Hey Siri', 9: 'AirPlay receiver', 10: 'AirPlay source', 11: 'Magic Switch', 12: 'Handoff', 13: 'Wi-Fi settings', 14: 'Instant Hotspot', 15: 'Nearby Action', 16: 'Nearby Info', 18: 'Find My' };
  const activities = { 0: 'Unknown', 1: 'Reporting disabled', 3: 'Idle', 5: 'Audio with screen locked', 7: 'Screen active', 9: 'Video with screen active', 10: 'Watch unlocked on wrist', 11: 'Recent interaction', 13: 'Driving mode', 14: 'Call' };
  const actions = { 1: 'Apple TV setup', 4: 'Backup', 5: 'Watch setup', 6: 'Apple TV pairing', 7: 'Internet relay', 8: 'Wi-Fi password sharing', 9: 'iOS setup', 10: 'Repair', 11: 'Speaker setup', 12: 'Apple Pay', 13: 'Whole-home audio setup', 14: 'Developer pairing', 15: 'Call answered', 16: 'Call ended', 17: 'Discovery ping', 18: 'Discovery response', 19: 'Remote autofill', 20: 'Companion proximity', 21: 'Remote management', 22: 'Autofill response', 23: 'Remote display' };
  const colors = ['White', 'Black', 'Red', 'Blue', 'Pink', 'Gray', 'Silver', 'Gold', 'Rose gold', 'Space gray', 'Dark blue', 'Light blue', 'Yellow'];
  const hex = values => Array.from(values, v => v.toString(16).padStart(2, '0')).join('');
  function bytes(value) {
    if (typeof value !== 'string' || value.length > 3300 || !/^(?:[\da-f]{2})*$/i.test(value)) return null;
    return Uint8Array.from(value.match(/../g) || [], part => parseInt(part, 16));
  }
  function parse(value) {
    const data = bytes(value), frames = [], errors = [];
    if (!data || data[0] !== 0x4c || data[1] !== 0) return { apple: false, frames, errors };
    for (let offset = 2; offset < data.length;) {
      if (offset + 2 > data.length) { errors.push('Incomplete Continuity header.'); break; }
      const type = data[offset++], size = data[offset++];
      if (offset + size > data.length) { errors.push(`Incomplete ${types[type] || 'unknown'} message: ${size} bytes declared, ${data.length - offset} received.`); break; }
      frames.push({ type, name: types[type] || `Unknown type 0x${hex([type])}`, data: data.slice(offset, offset + size), offset: offset - 2 }); offset += size;
    }
    return { apple: true, frames, errors };
  }
  const battery = value => value === 15 ? 'Unavailable' : `About ${Math.min(value, 10) * 10}%`;
  function headphones(data) {
    if (data.length < 3) return { fields: [], error: 'Incomplete headphone model.' };
    const model = hex(data.slice(1, 3)), title = models[model] || 'Apple-compatible headphones';
    const fields = [{ label: 'Model', value: title }, { label: 'Model code', value: `0x${model}` }, { label: 'Pairing advertisement', value: data[0] === 1 ? 'Paired format' : data[0] === 0 ? 'Pairing format' : `Unknown mode ${data[0]}` }];
    if (data[0] !== 1) return { model, title, fields, error: 'Battery decoding requires the paired 25-byte advertisement format.' };
    if (data.length !== 25) return { model, title, fields, error: 'This headphone payload is not the supported 25-byte format.' };
    const status = data[3], flipped = !(status & 0x20), packed = data[4], flags = data[5] >> 4;
    const left = flipped ? packed >> 4 : packed & 15, right = flipped ? packed & 15 : packed >> 4;
    const leftCharge = Boolean(flags & (flipped ? 2 : 1)), rightCharge = Boolean(flags & (flipped ? 1 : 2));
    const single = ['0a20', '1f20', '0520', '0620', '0920', '0c20', '1020', '0320'].includes(model);
    if (single) fields.push({ label: 'Headphone battery', value: battery(right) }, { label: 'Headphone charging', value: rightCharge ? 'Yes' : 'No' });
    else fields.push({ label: 'Left battery', value: battery(left) }, { label: 'Right battery', value: battery(right) }, { label: 'Case battery', value: battery(data[5] & 15) }, { label: 'Left charging', value: leftCharge ? 'Yes' : 'No' }, { label: 'Right charging', value: rightCharge ? 'Yes' : 'No' }, { label: 'Case charging', value: flags & 4 ? 'Yes' : 'No' });
    fields.push({ label: 'Color', value: colors[data[7]] || `Unknown (0x${hex([data[7]])})` }, { label: 'Wear / lid flags', value: `0x${hex([status, data[6]])}` });
    return { model, title, fields };
  }
  function identify(device = {}) {
    const parsed = parse(device.manufacturer);
    if (!parsed.apple) return null;
    const result = { category: 'vendor', title: 'Apple Continuity', confidence: parsed.errors.length ? 'Partial advertisement' : 'Manufacturer match', evidence: ['Apple company identifier 0x004C.'], fields: [], limitations: [...parsed.errors], sources };
    const counts = new Map();
    for (const frame of parsed.frames) {
      const count = (counts.get(frame.type) || 0) + 1; counts.set(frame.type, count);
      const prefix = `${frame.name}${count > 1 ? ` ${count}` : ''}`;
      result.fields.push({ label: prefix, value: `${frame.data.length} bytes` });
      if (frame.type === 7) {
        const decoded = headphones(frame.data); if (decoded.title) result.title = decoded.title;
        result.fields.push(...decoded.fields); if (decoded.error) result.limitations.push(decoded.error);
      } else if (frame.type === 16 && frame.data.length >= 2) {
        const activity = frame.data[0] & 15;
        result.fields.push({ label: 'Reported activity code', value: `${activities[activity] || 'Unmapped'} (0x${hex([activity])})` }, { label: 'Nearby Info flags', value: `0x${hex(frame.data.slice(0, 2))}` });
      } else if (frame.type === 15 && frame.data.length >= 2) result.fields.push({ label: 'Advertised action', value: `${actions[frame.data[1]] || 'Unmapped'} (0x${hex([frame.data[1]])})` });
      else if (frame.type === 9 && frame.data.length >= 6) result.fields.push({ label: 'AirPlay advertised IPv4', value: [...frame.data.slice(2, 6)].join('.') }, { label: 'AirPlay flags', value: `0x${hex([frame.data[0]])}` });
    }
    if (parsed.frames.length && !parsed.errors.length) result.confidence = 'Decoded broadcast';
    if (device.payloadTruncated) result.limitations.push('The board shortened this advertisement; some messages are missing.');
    result.limitations.push('Broadcasts are unauthenticated. Model and activity codes describe the received bytes; they do not establish ownership or a stable device identity.');
    if (parsed.frames.some(frame => frame.type === 7)) result.limitations.push('Battery levels have 10% resolution. Encrypted payloads and ambiguous wear/lid flags are left uninterpreted. Audio controls use a separate Bluetooth Classic connection.');
    return result;
  }
  const commands = [{ id: 'ear-detection', label: 'Automatic ear detection', description: 'Prepare an AACP setting packet for an authenticated Bluetooth Classic host.', inputs: [{ id: 'enabled', label: 'Ear detection', type: 'select', options: [{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }], default: 'true' }] }];
  function buildCommand(id, values = {}) {
    if (id !== 'ear-detection' || !['true', 'false', true, false].includes(values.enabled)) throw new Error('Choose an ear-detection setting.');
    const frame = parse(values.device?.manufacturer).frames.find(item => item.type === 7), decoded = frame && headphones(frame.data);
    if (!decoded?.model || !['0220', '0f20', '1320', '1920', '1b20', '0e20', '1420', '2420', '0a20', '1f20'].includes(decoded.model)) throw new Error('Select an identified AirPods broadcast before preparing a control packet.');
    const enabled = values.enabled === true || values.enabled === 'true';
    return { summary: `${enabled ? 'Enable' : 'Disable'} automatic ear detection`, transport: 'Bluetooth Classic L2CAP / AACP', hex: `0400040009000a0${enabled ? 1 : 2}000000`, warnings: ['Requires an established, authenticated AACP session on a Bluetooth Classic host. NanoC6 cannot transmit this packet.', 'The preview changes no device setting.'], sources: [sources[2]] };
  }
  return { identify, parse, headphones, sources, commands, buildCommand };
})();
if (typeof module !== 'undefined') module.exports = NanoAppleContinuity;
