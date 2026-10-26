#!/usr/bin/env python3
import argparse
import fcntl
import os
import select
import struct
import sys
import termios
import time
import tty


class H4Parser:
    def __init__(self, allowed=(1, 2, 4), maximum=1029):
        self.allowed, self.maximum = set(allowed), maximum
        self.buffer, self.expected, self.discard, self.errors = bytearray(), 0, 0, 0

    def reset(self):
        self.buffer.clear()
        self.expected = self.discard = 0

    def feed(self, data):
        packets = []
        for byte in data:
            if self.discard:
                self.discard -= 1
                continue
            if not self.buffer and byte not in self.allowed:
                self.errors += 1
                continue
            self.buffer.append(byte)
            header = {1: 4, 2: 5, 4: 3}[self.buffer[0]]
            if len(self.buffer) == header:
                size = self.buffer[-1] if self.buffer[0] != 2 else int.from_bytes(self.buffer[3:5], 'little')
                if size + header > self.maximum:
                    self.reset()
                    self.discard = size
                    self.errors += 1
                    continue
                self.expected = size + header
            if self.expected and len(self.buffer) == self.expected:
                packets.append(bytes(self.buffer))
                self.reset()
        return packets


def block(kind, payload):
    payload += b'\0' * (-len(payload) % 4)
    length = len(payload) + 12
    return struct.pack('<II', kind, length) + payload + struct.pack('<I', length)


class Pcapng:
    def __init__(self, stream):
        self.stream = stream
        stream.write(block(0x0A0D0D0A, struct.pack('<IHHq', 0x1A2B3C4D, 1, 0, -1)))
        stream.write(block(1, struct.pack('<HHI', 201, 0, 65535)))
        stream.flush()

    def packet(self, h4, received, timestamp_us=None):
        timestamp_us = time.time_ns() // 1000 if timestamp_us is None else timestamp_us
        data = struct.pack('>I', 1 if received else 0) + h4
        header = struct.pack('<IIIII', 0, timestamp_us >> 32, timestamp_us & 0xffffffff, len(data), len(data))
        self.stream.write(block(6, header + data))
        self.stream.flush()


class SerialHCI:
    def __init__(self, port, capture=None, output=None):
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.original = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)
            attrs = termios.tcgetattr(self.fd)
            attrs[2] |= termios.CLOCAL | termios.CREAD
            attrs[4] = attrs[5] = termios.B115200
            termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
            termios.tcflush(self.fd, termios.TCIOFLUSH)
        except Exception:
            os.close(self.fd)
            raise
        self.parser = H4Parser((2, 4))
        self.capture, self.output = capture, output
        self.last_data, self.rx_count, self.tx_count = time.monotonic(), 0, 0

    def close(self):
        try:
            termios.tcsetattr(self.fd, termios.TCSANOW, self.original)
        except termios.error:
            pass
        os.close(self.fd)

    def send(self, packet):
        parser = H4Parser((1, 2))
        if parser.feed(packet) != [packet] or parser.buffer or parser.discard or parser.errors:
            raise ValueError('Expected one complete H4 command or ACL packet, at most 1029 bytes')
        offset, deadline = 0, time.monotonic() + 3
        while offset < len(packet):
            if time.monotonic() > deadline:
                raise TimeoutError('USB serial write timed out')
            if select.select([], [self.fd], [], .1)[1]:
                try:
                    offset += os.write(self.fd, packet[offset:])
                except BlockingIOError:
                    pass
        self.tx_count += 1
        if self.capture:
            self.capture.packet(packet, False)

    def receive(self, timeout=.1):
        if not select.select([self.fd], [], [], timeout)[0]:
            if self.parser.buffer and time.monotonic() - self.last_data > 1:
                self.parser.errors += 1
                self.parser.reset()
            return []
        data = os.read(self.fd, 4096)
        if not data:
            raise ConnectionError('USB serial disconnected')
        self.last_data = time.monotonic()
        packets = self.parser.feed(data)
        for packet in packets:
            self.rx_count += 1
            if self.capture:
                self.capture.packet(packet, True)
            if self.output:
                self.output(packet)
        return packets

    def command(self, opcode, parameters=b'', timeout=4):
        self.send(b'\x01' + struct.pack('<HB', opcode, len(parameters)) + parameters)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for packet in self.receive():
                status = None
                if len(packet) >= 7 and packet[:2] == b'\x04\x0e' and int.from_bytes(packet[4:6], 'little') == opcode:
                    status = packet[6]
                if len(packet) >= 7 and packet[:2] == b'\x04\x0f' and int.from_bytes(packet[5:7], 'little') == opcode:
                    status = packet[3]
                if status is not None:
                    if status:
                        raise RuntimeError(f'HCI command 0x{opcode:04x} failed: status 0x{status:02x}')
                    return packet
        raise TimeoutError(f'HCI command 0x{opcode:04x} timed out; enable USB HCI mode and close other serial tools')

    def scan(self, active=False):
        self.command(0x0C03)
        self.command(0x0C01, b'\xff' * 7 + b'\x3f')
        self.command(0x2001, b'\x1f' + b'\x00' * 7)
        self.command(0x200B, struct.pack('<BHHBB', int(active), 160, 72, 0, 0))
        self.command(0x200C, b'\x01\x00')


def capture(port, stream=None, scan='none', duration=0, sends=(), stdio=False):
    writer = Pcapng(stream) if stream else None
    output = (lambda packet: (sys.stdout.buffer.write(packet), sys.stdout.buffer.flush())) if stdio else None
    if not writer and not stdio:
        output = lambda packet: print(packet.hex(), flush=True)
    serial = SerialHCI(port, writer, output)
    parser = H4Parser((1, 2))
    scanning = False
    try:
        if scan != 'none':
            serial.scan(scan == 'active')
            scanning = True
        for packet in sends:
            serial.send(packet)
        deadline = time.monotonic() + duration if duration else float('inf')
        while time.monotonic() < deadline:
            serial.receive(.05)
            if stdio and select.select([sys.stdin.buffer], [], [], 0)[0]:
                data = os.read(sys.stdin.fileno(), 4096)
                if not data:
                    break
                for packet in parser.feed(data):
                    serial.send(packet)
    except KeyboardInterrupt:
        pass
    finally:
        if scanning:
            try:
                serial.command(0x200C, b'\x00\x00', timeout=1)
            except (OSError, RuntimeError, TimeoutError):
                pass
        print(f'HCI: {serial.tx_count} host packets, {serial.rx_count} controller packets, {serial.parser.errors + parser.errors} framing errors', file=sys.stderr)
        serial.close()


def main():
    parser = argparse.ArgumentParser(description="Capture this controller's H4 traffic over USB serial")
    parser.add_argument('--port', required=True)
    parser.add_argument('--pcap', help='pcapng output file, or - for stdout')
    parser.add_argument('--scan', choices=('none', 'passive', 'active'), default='none')
    parser.add_argument('--duration', type=float, default=0)
    parser.add_argument('--send-h4', action='append', default=[], help='Complete H4 command or ACL packet as hex')
    parser.add_argument('--stdio', action='store_true', help='Relay H4 packets between stdin/stdout and USB')
    args = parser.parse_args()
    if args.stdio and args.pcap == '-':
        parser.error('--stdio and --pcap - cannot share stdout')
    stream = sys.stdout.buffer if args.pcap == '-' else open(args.pcap, 'wb') if args.pcap else None
    try:
        capture(args.port, stream, args.scan, args.duration, [bytes.fromhex(value) for value in args.send_h4], args.stdio)
    finally:
        if stream and stream is not sys.stdout.buffer:
            stream.close()


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
