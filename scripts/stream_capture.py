import argparse
import json
import signal
import sys
import time
import urllib.error
import urllib.request


def fetch(url):
    with urllib.request.urlopen(url, timeout=8) as response:
        return json.load(response)


def stream(base, mode, duration, interval, output):
    deadline = time.monotonic() + duration if duration else float('inf')
    cursor, boot, prior_uptime = 0, None, None
    observed = {}

    def emit(kind, **values):
        output.write(json.dumps({'type': kind, 'receivedAt': time.time(), **values}, separators=(',', ':')) + '\n')
        output.flush()

    while time.monotonic() < deadline:
        try:
            if mode == 'events':
                batch = fetch(f'{base}/api/events?after={cursor}')
                if boot is not None and boot != batch['bootId']:
                    emit('reboot', bootId=batch['bootId'])
                    cursor = 0
                    batch = fetch(f'{base}/api/events?after=0')
                boot = batch['bootId']
                if batch.get('dropped'):
                    emit('gap', count=batch['dropped'], bootId=boot)
                for event in batch['events']:
                    emit('event', bootId=boot, event=event)
                cursor = batch['nextSeq']
            else:
                state = fetch(f'{base}/api/state')
                if prior_uptime is not None and state['uptime'] < prior_uptime:
                    observed.clear()
                    emit('reboot')
                prior_uptime = state['uptime']
                for device in state['devices']:
                    key = (device['address'], device['addressType'])
                    fingerprint = (device['lastSeen'], device.get('payloadHex', ''), device['rssi'])
                    if observed.get(key) != fingerprint:
                        emit('advertisement', lastSeenAt=time.time() - max(0, state['uptime'] - device['lastSeen']), device=device)
                        observed[key] = fingerprint
                observed = {key: value for key, value in observed.items() if any((d['address'], d['addressType']) == key for d in state['devices'])}
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as error:
            emit('connection-error', message=str(error))
        time.sleep(min(interval, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description='Stream Gattelier API observations as NDJSON without changing BLE state.')
    parser.add_argument('url', help='For example http://nanoscope.local')
    parser.add_argument('--mode', choices=['scan', 'events'], default='scan')
    parser.add_argument('--seconds', type=float, default=10, help='Capture duration; 0 runs until Ctrl+C')
    parser.add_argument('--interval', type=float, default=.5, help='Polling interval, minimum 0.1 seconds')
    parser.add_argument('--output', help='New output file; existing files are not overwritten')
    args = parser.parse_args()
    if args.seconds < 0 or args.interval < .1:
        parser.error('Use a nonnegative duration and an interval of at least 0.1 seconds.')
    if not args.url.startswith(('http://', 'https://')):
        parser.error('URL must start with http:// or https://')
    output = open(args.output, 'x') if args.output else sys.stdout
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        stream(args.url.rstrip('/'), args.mode, args.seconds, args.interval, output)
    except KeyboardInterrupt:
        pass
    finally:
        if args.output:
            output.close()


if __name__ == '__main__':
    main()
