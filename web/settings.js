'use strict';

const NanoSettings = (() => {
  const key = 'nanoscope.settingsSection';
  let buttons = [];
  function reveal() {
    const selected = buttons.find(button => button.getAttribute('aria-selected') === 'true'), nav = selected?.parentElement;
    if (nav) {
      const style = getComputedStyle(nav);
      nav.setAttribute('aria-orientation', style.display === 'flex' && style.flexDirection.startsWith('row') ? 'horizontal' : 'vertical');
    }
    if (!nav?.clientWidth) return;
    const tab = selected.getBoundingClientRect(), viewport = nav.getBoundingClientRect();
    nav.scrollLeft += tab.left < viewport.left ? tab.left - viewport.left : tab.right > viewport.right ? tab.right - viewport.right : 0;
  }
  function show(section, focus = false) {
    const selected = buttons.find(button => button.dataset.section === section) || buttons[0];
    if (!selected) return;
    for (const button of buttons) {
      const current = button === selected;
      button.setAttribute('aria-selected', String(current)); button.tabIndex = current ? 0 : -1;
      document.getElementById(button.getAttribute('aria-controls')).hidden = !current;
    }
    if (focus) selected.focus();
    reveal();
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
    globalThis.addEventListener?.('resize', reveal);
    document.addEventListener('nanoscope:workspace', event => { if (event.detail?.view === 'settings') reveal(); });
  }
  function open(section) { NanoWorkspace.show('settings'); show(section); }
  return { mount, open };
})();

document.addEventListener('toggle', event => {
  if (!event.target.matches?.('details.help') || !event.target.open) return;
  for (const help of document.querySelectorAll('details.help[open]')) if (help !== event.target) help.open = false;
}, true);
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll(':is(details.help, .traffic-filter-menu, .traffic-export-menu, .header-connection)[open]')) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const open = [...document.querySelectorAll(':is(details.help, .traffic-filter-menu, .traffic-export-menu, .header-connection)[open]')].find(menu => menu.getClientRects().length);
  if (open) { event.preventDefault(); open.open = false; open.querySelector('summary').focus(); }
});
