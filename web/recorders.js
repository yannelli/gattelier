'use strict';

const NanoRecorders = (() => {
  function bytes(value) {
    if (typeof value !== 'string') return null;
    const hex = value.replace(/\s/g, '');
    if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null;
    return Uint8Array.from(hex.match(/../g) || [], pair => parseInt(pair, 16));
  }
  function uuid(value) {
    const normalized = String(value || '').toLowerCase().replace(/^0x/, '');
    return /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/.test(normalized) ? normalized.slice(4, 8) : normalized;
  }
  const uint16 = (data, offset) => data[offset] | (data[offset + 1] << 8);
  const short = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
  function identify(device) {
    if (!device || typeof device !== 'object') return null;
    const data = bytes(device.manufacturer);
    if (data && data.length >= 22 && data[2] === 2 && data[5] === 4 && data[10] === 8) {
      const project = uint16(data, 3);
      if (project === 881 || project === 883) {
        const serial = Array.from(data.slice(11, 19), value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
        const protocolVersion = uint16(data, 20), encrypted = protocolVersion >= 20;
        return { product: 'PLAUD Note Pro', serial, protocolVersion, encrypted,
          summary: `Serial ${serial} · protocol ${protocolVersion}${encrypted ? ' · encrypted session' : ''}` };
      }
    }
    const services = Array.isArray(device.services) ? device.services : [];
    if (/^PKT01_/.test(device.name || '') && services.some(value => ['5536', '2222'].includes(uuid(value)))) {
      return { product: 'Pocket Recorder', summary: 'Pocket name and advertised service match' };
    }
    return null;
  }
  function pocket(message) {
    const parts = message.replace(/\0+$/, '').trim().split('&');
    if (parts[0] !== 'APP' && parts[0] !== 'MCU') return '';
    const command = parts[1];
    if (!/^[A-Z_]+$/.test(command || '')) return '';
    if (parts[0] === 'APP') {
      if (command === 'SK') return 'Pocket authentication command · redacted';
      if (command === 'LIST_DIRS') return 'Pocket: list recording dates';
      if (command === 'LIST') return parts[2] ? `Pocket: list recordings for ${short(parts[2])}` : 'Pocket recording-list command';
      if (command === 'U') return parts[2] && parts[3] ? `Pocket: download ${short(parts[2])}/${short(parts[3])}` : 'Pocket download command · incomplete arguments';
      if (command === 'FW') return 'Pocket: request firmware version';
      if (command === 'SPACE') return 'Pocket: request storage information';
      return `Pocket command ${command}`;
    }
    if (command === 'SK') return parts[2] === 'OK' ? 'Pocket authentication accepted' : parts[2] === 'ERR' ? 'Pocket authentication rejected' : 'Pocket authentication reply';
    if (command === 'DIRS') return `Pocket recording date: ${short(parts[2])}`;
    if (command === 'DIRS_SUM' && /^\d+$/.test(parts[2])) return `Pocket: ${parts[2]} recording dates`;
    if (command === 'LIST' && /^\d+$/.test(parts[2])) return `Pocket: ${parts[2]} recordings`;
    if (command === 'F' && parts.length === 5 && /^\d+$/.test(parts[4])) return `Pocket recording: ${short(parts[2])}/${short(parts[3])} · ${parts[4]}s`;
    if (command === 'U' && /^\d+$/.test(parts[2])) return `Pocket download: ${parts[2]} bytes announced`;
    if (command === 'FW') return `Pocket firmware: ${short(parts.slice(2).join('&'))}`;
    if (command === 'SPA') return `Pocket storage: ${short(parts.slice(2).join('&'))}`;
    return `Pocket reply ${command}`;
  }
  function decode(event) {
    if (!event || typeof event !== 'object') return '';
    const data = bytes(event.hex), characteristic = uuid(event.uuid);
    const plaud = characteristic === '2bb0' || characteristic === '2bb1';
    if (event.redacted && characteristic === '2bb1') return 'PLAUD authentication signature · redacted';
    if (!data?.length) return plaud ? 'PLAUD protocol payload' : '';
    const text = new TextDecoder().decode(data);
    if (text.includes('APP&SK&')) return 'Pocket authentication command · redacted';
    if (/^(?:APP|MCU)&/.test(text)) {
      const labels = text.split(/(?=(?:APP|MCU)&)/).map(pocket).filter(Boolean);
      if (labels.length) return `${labels.slice(0, 3).join(' · ')}${labels.length > 3 ? ' · …' : ''}${event.truncated ? ' · truncated' : ''}`;
    }
    if (!plaud) return '';
    if (data.length >= 2) {
      const opcode = uint16(data, 0);
      if (opcode === 0xfe11) return `PLAUD FE11 public-key request${event.truncated ? ' · truncated' : ''}`;
      if (opcode === 0xfe10 || opcode === 0xfe12) {
        const label = opcode === 0xfe10 ? 'PLAUD FE10 signature' : characteristic === '2bb0' ? 'PLAUD FE12 encrypted session secret' : 'PLAUD FE12 public key';
        if (data.length < 4) return `${label} · truncated header`;
        const total = data[2], index = data[3];
        if (!total || index >= total || data.length > 104) return `${label} · invalid chunk header`;
        return `${label} · chunk ${index + 1}/${total} (index ${index})${event.truncated || data.length === 4 ? ' · truncated' : ''}`;
      }
    }
    return event.encrypted === true ? 'PLAUD encrypted session payload' : 'PLAUD protocol payload';
  }
  return { identify, decode };
})();
if (typeof module !== 'undefined') module.exports = NanoRecorders;
