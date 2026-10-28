'use strict';

const NanoSessionAlerts = (() => {
  const storageKey = 'nanoscope.session.alerts.v1';
  function create(options = {}) {
    let storage; try { storage = options.storage ?? globalThis.localStorage; } catch {}
    const NotificationAPI = options.Notification ?? globalThis.Notification;
    const AudioAPI = options.AudioContext ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
    let settings = { notifications: false, connect: false, disconnect: false, error: false };
    let previous = null, audio, errorText = '', lastSound = -Infinity, permissionRequest = 0;
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
      for (const key of Object.keys(settings)) settings[key] = saved?.[key] === true;
    } catch {}
    function save() { try { storage?.setItem(storageKey, JSON.stringify(settings)); } catch {} options.changed?.(); }
    function permission() { return NotificationAPI?.permission || 'unsupported'; }
    async function setNotifications(enabled) {
      const request = ++permissionRequest;
      if (!enabled) { settings.notifications = false; save(); return false; }
      let granted = permission();
      if (granted === 'default') { try { granted = await NotificationAPI.requestPermission(); } catch { granted = 'denied'; } }
      if (request !== permissionRequest) return settings.notifications;
      settings.notifications = granted === 'granted'; save(); return settings.notifications;
    }
    async function unlockAudio() {
      if (!AudioAPI) return false;
      try { audio ||= new AudioAPI(); if (audio.state === 'suspended') await audio.resume(); return audio.state === 'running'; } catch { return false; }
    }
    async function setSound(kind, enabled) {
      if (!['connect', 'disconnect', 'error'].includes(kind)) return false;
      settings[kind] = Boolean(enabled); save();
      if (enabled) await unlockAudio();
      return settings[kind];
    }
    function sound(kind) {
      if (!settings[kind] || audio?.state !== 'running') return;
      const now = audio.currentTime;
      if (now - lastSound < .4) return;
      lastSound = now;
      try {
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        const notes = { connect: [520, 780], disconnect: [520, 350], error: [330, 330] }[kind];
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(notes[0], now); oscillator.frequency.setValueAtTime(notes[1], now + .09);
        gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.055, now + .015); gain.gain.exponentialRampToValueAtTime(.001, now + .22);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + .23);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      } catch {}
    }
    async function notify(kind, body) {
      const notificationOptions = { body, tag: `gattelier-${kind}`, silent: true };
      try {
        const notification = new NotificationAPI('Gattelier', notificationOptions);
        notification.onclick = () => { globalThis.window?.focus(); notification.close(); };
        return;
      } catch {}
      try {
        const worker = options.serviceWorker ?? globalThis.navigator?.serviceWorker;
        const registration = await worker?.getRegistration();
        await registration?.showNotification('Gattelier', notificationOptions);
      } catch {}
    }
    function emit(kind, body) {
      options.onEvent?.({ kind, body }); sound(kind);
      if (!settings.notifications || permission() !== 'granted') return;
      if (options.hidden ? !options.hidden() : !globalThis.document?.hidden) return;
      void notify(kind, body);
    }
    function update({ state = {}, online, error = '' } = {}) {
      if (typeof online !== 'boolean') return;
      const ble = state.ble || {};
      const device = (state.devices || []).find(item => item.address?.toLowerCase() === ble.address?.toLowerCase() && item.addressType === ble.addressType);
      const label = options.getDeviceLabel?.(device || { address: ble.address, addressType: ble.addressType }) || device?.label || device?.name || ble.address || 'Device';
      const current = { online, connected: online && Boolean(ble.connected), address: String(ble.address || '').toLowerCase(), addressType: ble.addressType, label };
      if (previous) {
        const changed = previous.address !== current.address || previous.addressType !== current.addressType;
        if (previous.connected && (!current.connected || changed)) emit('disconnect', !online ? 'Board unavailable. Bluetooth connection status is unknown.' : `${previous.label} disconnected`);
        if (current.connected && (!previous.connected || changed)) emit('connect', `${current.label} connected`);
        if (error && error !== errorText) emit('error', String(error));
      }
      previous = current; errorText = String(error || '');
    }
    return { update, setSound, setNotifications, unlockAudio, permission, audioSupported: Boolean(AudioAPI), preferences: () => ({ ...settings }) };
  }
  function mount(root, controller) {
    const notification = root.querySelector('#session-notifications'), status = root.querySelector('#notification-permission');
    function render() {
      const preferences = controller.preferences(), permission = controller.permission();
      notification.checked = preferences.notifications && permission === 'granted';
      notification.disabled = permission === 'unsupported';
      status.textContent = { unsupported: 'Notifications are unavailable in this browser.', denied: 'Blocked by the browser. Allow notifications in site settings.', default: 'Off. Enable to request browser permission.', granted: preferences.notifications ? 'On. Alerts appear when Gattelier is in the background.' : 'Off. Browser permission is granted.' }[permission];
      for (const input of root.querySelectorAll('[data-session-sound]')) { input.checked = preferences[input.dataset.sessionSound]; input.disabled = !controller.audioSupported; }
    }
    notification.addEventListener('change', async () => { await controller.setNotifications(notification.checked); render(); });
    for (const input of root.querySelectorAll('[data-session-sound]')) input.addEventListener('change', async () => { await controller.setSound(input.dataset.sessionSound, input.checked); render(); });
    globalThis.document?.addEventListener('pointerdown', () => { if (Object.entries(controller.preferences()).some(([key, value]) => key !== 'notifications' && value)) controller.unlockAudio(); });
    globalThis.document?.addEventListener('keydown', () => { if (Object.entries(controller.preferences()).some(([key, value]) => key !== 'notifications' && value)) controller.unlockAudio(); });
    render(); return { render };
  }
  return { create, mount };
})();
if (typeof module !== 'undefined') module.exports = NanoSessionAlerts;
