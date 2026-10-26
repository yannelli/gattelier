'use strict';

const NanoTheme = (() => {
  const key = 'nanoscope.appearance';
  const modes = ['system', 'light', 'dark'];
  const normalize = value => modes.includes(value) ? value : 'system';
  const resolve = (mode, dark) => normalize(mode) === 'system' ? dark ? 'dark' : 'light' : mode;
  function init({ storage, media = window.matchMedia('(prefers-color-scheme: dark)'), root = document.documentElement, control = document.getElementById('theme-mode'), meta = document.querySelector('meta[name="theme-color"]') } = {}) {
    let mode = 'system';
    try { storage ??= window.localStorage; mode = normalize(storage.getItem(key)); } catch {}
    function apply() {
      const theme = resolve(mode, media.matches);
      root.dataset.theme = theme; root.dataset.appearance = mode;
      if (control) {
        const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} appearance`;
        control.setAttribute('aria-label', label);
        control.title = label;
      }
      if (meta) meta.content = theme === 'dark' ? '#141416' : '#f5f5f7';
    }
    control?.addEventListener('click', () => {
      mode = resolve(mode, media.matches) === 'dark' ? 'light' : 'dark';
      try { storage?.setItem(key, mode); } catch {}
      apply();
    });
    media.addEventListener?.('change', apply);
    apply();
    return { mode: () => mode, theme: () => resolve(mode, media.matches) };
  }
  return { init, normalize, resolve };
})();
if (typeof module !== 'undefined') module.exports = NanoTheme;
