export const encoder = new TextEncoder();

export function frame(value) { return `@G1 ${JSON.stringify({ v: 1, ...value })}\n`; }

export class FakePort {
  requests = [];
  writes = [];
  closes = 0;
  async open(options) {
    this.openOptions = options;
    this.readable = new ReadableStream({ start: controller => { this.input = controller; } });
    this.writable = new WritableStream({
      write: bytes => {
        this.writes.push(bytes);
        const request = JSON.parse(new TextDecoder().decode(bytes).trimStart().slice(4));
        this.requests.push(request);
        if (this.onRequest) return this.onRequest(request);
        if (request.path === '/api/serial') {
          const body = JSON.parse(request.body);
          this.respond(request.id, JSON.stringify({ protocol: 'gattelier-serial', version: 1, active: body.action !== 'close', wifiSuspended: body.wifiOff ?? true }));
        }
      },
    });
  }
  async setSignals(value) { this.signals = value; }
  async close() { this.closes++; }
  emit(value) { this.input.enqueue(typeof value === 'string' ? encoder.encode(value) : value); }
  respond(id, body, status = 200) {
    const bytes = typeof body === 'string' ? encoder.encode(body) : body;
    this.emit(frame({ id, event: 'start', status, type: 'application/json' }));
    for (let offset = 0; offset < bytes.length; offset += 768) {
      this.emit(frame({ id, event: 'data', data: Buffer.from(bytes.slice(offset, offset + 768)).toString('base64') }));
    }
    this.emit(frame({ id, event: 'end', ok: true }));
  }
}

export const tick = () => new Promise(resolve => setImmediate(resolve));
