'use strict';

const NanoSettings = (() => {
  const key = 'nanoscope.settingsSection';
  let buttons = [];
  function show(section, focus = false) {
    const selected = buttons.find(button => button.dataset.section === section) || buttons[0];
    if (!selected) return;
    for (const button of buttons) {
      const current = button === selected;
      button.setAttribute('aria-selected', String(current)); button.tabIndex = current ? 0 : -1;
      document.getElementById(button.getAttribute('aria-controls')).hidden = !current;
    }
    if (focus) selected.focus();
    try { localStorage.setItem(key, selected.dataset.section); } catch {}
  }
  function mount() {
    buttons = [...document.querySelectorAll('.settings-nav [data-section]')];
    for (const button of buttons) {
      button.addEventListener('click', () => show(button.dataset.section));
      button.addEventListener('keydown', event => {
        const index = buttons.indexOf(button);
        const next = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault(); show(buttons[(next + buttons.length) % buttons.length].dataset.section, true);
      });
    }
    let saved; try { saved = localStorage.getItem(key); } catch {}
    show(saved);
  }
  function open(section) { NanoWorkspace.show('settings'); show(section); }
  return { mount, open };
})();

// Help popovers: only one stays open, and outside clicks or Escape close it.
document.addEventListener('toggle', event => {
  if (!event.target.matches?.('details.help') || !event.target.open) return;
  for (const help of document.querySelectorAll('details.help[open]')) if (help !== event.target) help.open = false;
}, true);
document.addEventListener('click', event => {
  for (const help of document.querySelectorAll('details.help[open]')) if (!help.contains(event.target)) help.open = false;
});
document.addEventListener('keydown', event => {
  const open = event.key === 'Escape' && document.querySelector('details.help[open]');
  if (open) { open.open = false; open.querySelector('summary').focus(); }
});
