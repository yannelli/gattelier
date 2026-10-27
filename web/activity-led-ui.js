'use strict';

const NanoActivityLedUI = (() => {
  function mount(panel, lab) {
    panel.classList.add('settings-card');
    panel.innerHTML = '<div class="panel-heading"><div><h2>Activity light</h2><p>Flashes blue with BLE and USB traffic</p></div></div><div class="api-form"><label class="led-level"><span>Brightness <output data-led-level>3%</output></span><input data-led-brightness type="range" min="0" max="100" step="1" value="3" aria-label="Activity light brightness"></label><div class="api-actions"><button data-led-test class="button secondary" type="button">Test flash</button><button data-led-off class="button quiet" type="button">Turn off</button></div><p data-led-status class="vendor-note" role="status"></p></div>';
    const slider = panel.querySelector('[data-led-brightness]'), level = panel.querySelector('[data-led-level]'), status = panel.querySelector('[data-led-status]');
    const buttons = [...panel.querySelectorAll('button')]; let available = false, busy = false, initialized = false;
    function controls() { slider.disabled = !available || busy; for (const button of buttons) button.disabled = !available || busy; }
    async function request(body) {
      if (busy) return;
      busy = true; controls();
      try {
        const { response, result } = await NanoAPI.requestJson('activity-led', body);
        if (!response.ok || !result) throw new Error(result?.error || 'Could not change LED brightness.');
        slider.value = result.brightness; level.textContent = `${result.brightness}%`; initialized = true;
        status.textContent = !result.ready ? 'The activity light is unavailable.' : result.brightness ? '' : 'Off';
      } catch (error) { status.textContent = error.name === 'AbortError' ? 'The board did not respond.' : error.message; }
      finally { busy = false; controls(); }
    }
    slider.addEventListener('input', () => { level.textContent = `${slider.value}%`; });
    slider.addEventListener('change', () => request({ brightness: Number(slider.value), test: true }));
    panel.querySelector('[data-led-test]').addEventListener('click', () => request({ test: true }));
    panel.querySelector('[data-led-off]').addEventListener('click', () => request({ brightness: 0 }));
    lab.onState((_, online) => { available = online; if (online && !initialized && !busy) request(); controls(); });
    globalThis.addEventListener('nanoscope:api-change', () => { initialized = false; available = false; controls(); });
    controls();
  }
  return { mount };
})();
