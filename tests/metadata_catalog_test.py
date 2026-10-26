import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("metadata_catalog", Path(__file__).resolve().parents[1] / "scripts/update_metadata.py")
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class AssignedNamesTest(unittest.TestCase):
    def test_plain_and_quoted_names(self):
        source = '''# ignored notice
uuids:
 - uuid: 0x2A05
   name: Service Changed
   id: org.bluetooth.characteristic.gatt.service_changed
 - uuid: 0x2B29
   name: "Client Supported Features"
 - uuid: 0x2B3A
   name: 'Server''s supported features'
'''
        self.assertEqual(catalog.assigned_names(source), {
            "2a05": "Service Changed", "2b29": "Client Supported Features", "2b3a": "Server's supported features"
        })

    def test_missing_and_repeated_identifiers_fail(self):
        for source in ["name: Unscoped", "- uuid: 0x1800", "- uuid: 0x1800\n- uuid: 0x1801\nname: Test",
                       "- uuid: 0x1800\nname: A\n- uuid: 0x1800\nname: B"]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                catalog.assigned_names(source)

    def test_unsupported_multiline_names_fail(self):
        for name in ["|", ">", "", "Unknown # inline comment"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                catalog.assigned_names("- uuid: 0x1800\nname: " + name)


if __name__ == "__main__":
    unittest.main()
