#!/usr/bin/env python3
import argparse
import glob
import signal
import sys
from usb_hci import capture


def main():
    parser = argparse.ArgumentParser()
    for flag in ('extcap-interfaces', 'extcap-dlts', 'extcap-config', 'capture'):
        parser.add_argument('--' + flag, action='store_true')
    parser.add_argument('--extcap-interface', default='nanoscope-hci')
    parser.add_argument('--extcap-version')
    parser.add_argument('--fifo')
    parser.add_argument('--port')
    parser.add_argument('--scan', choices=('none', 'passive', 'active'), default='passive')
    args, _ = parser.parse_known_args()
    if args.extcap_interfaces:
        print('extcap {version=1.0}{display=Gattelier USB HCI}')
        print('interface {value=nanoscope-hci}{display=Gattelier HCI over USB serial}')
    elif args.extcap_dlts:
        print('dlt {number=201}{name=BLUETOOTH_HCI_H4_WITH_PHDR}{display=Bluetooth HCI H4 with direction}')
    elif args.extcap_config:
        print('arg {number=0}{call=--port}{display=NanoC6 serial port}{type=fileselect}{mustexist=true}{required=true}')
        print('arg {number=1}{call=--scan}{display=Controller scanning}{type=selector}')
        for mode, name in (('passive', 'Passive advertisements'), ('active', 'Active scan responses'), ('none', 'Receive existing controller events')):
            print(f'value {{arg=1}}{{value={mode}}}{{display={name}}}{{default={str(mode == "passive").lower()}}}')
    elif args.capture:
        if not args.fifo or not args.port:
            parser.error('Capture requires --fifo and --port; enable USB HCI mode in Gattelier first')
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        with open(args.fifo, 'wb', buffering=0) as stream:
            capture(args.port, stream, args.scan)
    else:
        ports = sorted(glob.glob('/dev/cu.usbmodem*') + glob.glob('/dev/ttyACM*'))
        print('Enable USB HCI in Gattelier, then select this extcap interface in Wireshark.')
        print('Serial ports: ' + ', '.join(ports))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
