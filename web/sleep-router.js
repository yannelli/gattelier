'use strict';

const NanoSleepRouter = (() => {
  function mount(container, lab) {
    const fuzion = document.createElement('div'), mcr = document.createElement('div'), missing = document.createElement('p');
    missing.className = 'hint'; missing.textContent = 'Select a Sleep Number bed to open its matching reader.';
    container.replaceChildren(fuzion, mcr, missing); NanoSleep.mount(fuzion, lab); NanoSleepMcr.mount(mcr, lab);
    function render() {
      const context = NanoConnection.snapshot(), device = context.selected;
      const found = device ? NanoDeviceLibrary.match(device, context.state) : [];
      const useMcr = found.some(item => item.id === 'sleep-mcr'), useFuzion = found.some(item => item.id === 'sleep-fuzion');
      mcr.hidden = !useMcr; fuzion.hidden = !useFuzion; missing.hidden = useMcr || useFuzion;
    }
    lab.onState(render); document.addEventListener('nanoscope:selection', render); render();
  }
  return { mount };
})();
