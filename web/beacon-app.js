'use strict';

const NanoBeaconApp = (() => {
  function mount(container, hooks) {
    const reader = NanoProtocolApp.mount(container, 'tracker', hooks), body = container.querySelector('.protocol-body');
    const signal = document.createElement('section'); signal.className = 'beacon-signal'; body.prepend(signal);
    let signature = '';
    return { render(device, state) {
      reader.render(device, state);
      const next = JSON.stringify([device?.address, device?.addressType, device?.history, device?.observations]);
      if (next === signature) return; signature = next; signal.replaceChildren();
      if (!device) return;
      signal.append(NanoInsights.signalChart(device));
      const samples = (device.history || []).filter(sample => Number.isFinite(sample.rssi));
      if (!samples.length) return;
      const values = samples.map(sample => sample.rssi).sort((a, b) => a - b), average = values.reduce((a, b) => a + b, 0) / values.length;
      const list = document.createElement('dl'); list.className = 'sensor-statistics';
      for (const [label, value] of [['Latest', `${device.rssi} dBm`], ['Average', `${average.toFixed(1)} dBm`], ['Median', `${(values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2).toFixed(1)} dBm`], ['Sample window', `${Math.max(0, (samples.at(-1).at - samples[0].at) / 1000).toFixed(1)} s`]]) {
        const row = document.createElement('div'), term = document.createElement('dt'), description = document.createElement('dd'); term.textContent = label; description.textContent = value; row.append(term, description); list.append(row);
      }
      signal.append(list);
    } };
  }
  return { mount };
})();
