import importlib.util
import io
import json
import os
import pty
import struct
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('usb_hci', ROOT / 'scripts/usb_hci.py')
hci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hci)


class HciTests(unittest.TestCase):
    def test_fragmented_coalesced_and_oversized_frames(self):
        parser = hci.H4Parser()
        self.assertEqual(parser.feed(bytes.fromhex('01030c')), [])
        self.assertEqual(parser.feed(bytes.fromhex('00040e0401030c00')), [bytes.fromhex('01030c00'), bytes.fromhex('040e0401030c00')])
        self.assertEqual(parser.feed(bytes.fromhex('0200000104') + b'\x01' * 1025), [])
        self.assertEqual(parser.errors, 1)
        self.assertEqual(parser.feed(bytes.fromhex('01030c00')), [bytes.fromhex('01030c00')])

    def test_capture_blocks_lengths_direction_and_timestamp(self):
        output = io.BytesIO()
        writer = hci.Pcapng(output)
        writer.packet(bytes.fromhex('01030c00'), False, 1234567)
        writer.packet(bytes.fromhex('040e0401030c00'), True, 1234568)
        data, blocks, offset = output.getvalue(), [], 0
        while offset < len(data):
            kind, length = struct.unpack_from('<II', data, offset)
            self.assertEqual(length % 4, 0)
            self.assertEqual(struct.unpack_from('<I', data, offset + length - 4)[0], length)
            blocks.append((kind, data[offset + 8:offset + length - 4]))
            offset += length
        self.assertEqual([kind for kind, _ in blocks], [0x0A0D0D0A, 1, 6, 6])
        self.assertEqual(struct.unpack_from('<H', blocks[1][1])[0], 201)
        self.assertEqual(struct.unpack_from('>I', blocks[2][1], 20)[0], 0)
        self.assertEqual(struct.unpack_from('>I', blocks[3][1], 20)[0], 1)
        self.assertEqual(struct.unpack_from('<I', blocks[2][1], 8)[0], 1234567)

    def test_serial_reset_with_actual_pty_framing(self):
        master, slave = pty.openpty()
        output = io.BytesIO()
        serial = hci.SerialHCI(os.ttyname(slave), hci.Pcapng(output))
        received = []
        def controller():
            received.append(os.read(master, 4))
            os.write(master, bytes.fromhex('040e'))
            os.write(master, bytes.fromhex('0401030c00'))
        thread = threading.Thread(target=controller)
        thread.start()
        try:
            response = serial.command(0x0C03)
            self.assertEqual(response.hex(), '040e0401030c00')
            self.assertEqual(serial.tx_count, 1)
            self.assertEqual(serial.rx_count, 1)
            with self.assertRaises(ValueError): serial.send(b'\x01\x03')
        finally:
            thread.join(2)
            serial.close()
            os.close(master); os.close(slave)
        self.assertEqual(received, [bytes.fromhex('01030c00')])

    def test_wireshark_decodes_command_and_event_direction(self):
        with tempfile.NamedTemporaryFile(suffix='.pcapng') as file:
            writer = hci.Pcapng(file)
            writer.packet(bytes.fromhex('01030c00'), False)
            writer.packet(bytes.fromhex('040e0401030c00'), True)
            result = subprocess.run(['tshark', '-r', file.name, '-T', 'fields', '-e', '_ws.col.Info'], text=True, capture_output=True, check=True)
            lines = result.stdout.splitlines()
            self.assertIn('Sent', lines[0]); self.assertIn('Reset', lines[0])
            self.assertIn('Rcvd', lines[1]); self.assertIn('Command Complete', lines[1])

    def test_extcap_lists_hci_interface_and_link_type(self):
        script = ROOT / 'scripts/nanoscope_extcap.py'
        for flag, expected in (('--extcap-interfaces', 'nanoscope-hci'), ('--extcap-dlts', 'number=201'), ('--extcap-config', '--port')):
            output = subprocess.check_output(['python3', str(script), flag], text=True)
            self.assertIn(expected, output)


if __name__ == '__main__':
    unittest.main()
