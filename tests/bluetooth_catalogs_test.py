from collections import Counter
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bluetooth_catalogs", ROOT / "scripts/update_bluetooth_catalogs.py")
catalogs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalogs)


class BluetoothCatalogsTest(unittest.TestCase):
    def test_uuid_names_keep_quotes_unicode_and_canonical_identifiers(self):
        source = '''uuids:
 - uuid: 0x2A05
   name: Service Changed
   id: org.bluetooth.characteristic.gatt.service_changed
 - uuid: "ABCD1234-5678-90AB-CDEF-0123456789AB"
   name: 'Maker''s café'
 - uuid: 0000180F-0000-1000-8000-00805F9B34FB
   name: "Battery"
'''
        parsed = catalogs.uuid_entries(source, "characteristic", "https://example.com/source")
        self.assertEqual([entry["uuid"] for entry in parsed], ["2a05", "abcd1234-5678-90ab-cdef-0123456789ab", "180f"])
        self.assertEqual(parsed[1]["name"], "Maker's café")

    def test_uuid_parser_rejects_truncation_duplicates_and_unsupported_yaml(self):
        for source in ["<html>error</html>", "uuids:\n - uuid: 0x1800", "uuids:\n - uuid: 0x1800\n   name: A\n - uuid: 0x1800\n   name: B", "uuids:\n - uuid: 0x12345678\n   name: Invalid", "uuids:\n - uuid: 0x1800\n   name: |\n     wrapped", "uuids:\n - uuid: 0x1800\n   name: A # comment", "uuids:\n - uuid: 0x1800\n   name: A\n   name: B"]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                catalogs.uuid_entries(source, "service", "https://example.com")

    def test_appearance_flattens_generic_and_explicit_subcategories(self):
        source = '''appearance_values:
 - category: 0x001
   name: Phone
 - category: 0x002
   name: Computer
   subcategory:
    - value: 0x03
      name: Laptop
'''
        parsed = catalogs.appearance_entries(source, "https://example.com")
        self.assertEqual([(entry["code"], entry["name"], entry["category"], entry["subcategory"]) for entry in parsed], [(64, "Phone", "Phone", 0), (128, "Computer", "Computer", 0), (131, "Laptop", "Computer", 3)])
        for suffix in ["    - value: 0x03\n      name: Repeated\n", "    - value: 0x40\n      name: Overflow\n", "    - value: 0x04\n"]:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                catalogs.appearance_entries(source + suffix, "https://example.com")

    def test_ad_parser_preserves_context_dependent_shared_codes(self):
        source = '''ad_types:
 - value: 0x10
   name: Device ID
   reference: EIR
 - value: 0x10
   name: Security Manager TK Value
   reference: OOB
'''
        parsed = catalogs.ad_entries(source, "https://example.com")
        self.assertEqual([entry["code"] for entry in parsed], [16, 16])
        self.assertEqual([entry["name"] for entry in parsed], ["Device ID", "Security Manager TK Value"])
        with self.assertRaises(ValueError):
            catalogs.ad_entries(source + " - value: 0x10\n   name: Device ID\n", "https://example.com")

    def fixture_sources(self):
        sources = {}
        for index, (path, (_, minimum)) in enumerate(catalogs.UUID_TABLES.items()):
            sources[path] = "uuids:\n" + "".join(f" - uuid: 0x{index * 2048 + number:04x}\n   name: Entry {number}\n" for number in range(minimum))
        sources[catalogs.APPEARANCE] = "appearance_values:\n" + "".join(f" - category: 0x{number:03x}\n   name: Category {number}\n" for number in range(342))
        sources[catalogs.AD_TYPES] = "ad_types:\n" + "".join(f" - value: 0x{number:02x}\n   name: AD {number}\n" for number in range(51))
        return sources

    def test_cross_table_uuid_conflict_is_reported_with_both_entries(self):
        sources = self.fixture_sources()
        sources["uuids/member_uuids.yaml"] = sources["uuids/member_uuids.yaml"].replace("0x2800", "0x0000", 1)
        with self.assertRaisesRegex(ValueError, "UUID conflict for 0000"):
            catalogs.build_catalogs(sources)

    def test_local_source_directory_updates_all_catalogs_with_complete_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path, source in self.fixture_sources().items():
                target = root / "sources" / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(source)
            output = root / "catalogs"
            counts = catalogs.update(root / "sources", output)
            self.assertEqual(counts, {"bluetooth-uuids": 1484, "bluetooth-appearance": 342, "bluetooth-ad-types": 51})
            original = {path.name: path.read_bytes() for path in output.iterdir()}
            (root / "sources" / catalogs.AD_TYPES).write_text("ad_types:\n - value: 0x01\n   name: Truncated\n")
            with self.assertRaises(ValueError):
                catalogs.update(root / "sources", output)
            self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, original)
            (root / "sources" / catalogs.APPEARANCE).unlink()
            with self.assertRaises(OSError):
                catalogs.update(root / "sources", output)
            self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, original)

    def test_failed_download_preserves_existing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            original = output / "bluetooth-uuids.json"
            original.write_text("existing")
            with patch.object(catalogs.urllib.request, "urlopen", side_effect=OSError("download failed")):
                with self.assertRaises(OSError):
                    catalogs.update(output_dir=output)
            self.assertEqual(original.read_text(), "existing")
            self.assertEqual(len(list(output.iterdir())), 1)

    def test_generated_official_catalog_coverage_and_provenance(self):
        data = {identifier: json.loads((ROOT / "catalogs" / f"{identifier}.json").read_text()) for identifier in ["bluetooth-uuids", "bluetooth-appearance", "bluetooth-ad-types"]}
        uuids = data["bluetooth-uuids"]["entries"]
        self.assertEqual(Counter(entry["kind"] for entry in uuids), {kind: count for kind, count in catalogs.UUID_TABLES.values()})
        by_uuid = {entry["uuid"]: entry for entry in uuids}
        self.assertEqual(by_uuid["febe"]["name"], "Bose Corporation")
        self.assertEqual(by_uuid["feb9"]["name"], "LG Electronics")
        self.assertEqual(by_uuid["fd5a"]["kind"], "member-service")
        self.assertEqual(by_uuid["fff6"]["kind"], "sdo-service")
        self.assertEqual(by_uuid["180f"]["kind"], "service")
        self.assertEqual(len(by_uuid), len(uuids))
        for catalog in data.values():
            self.assertEqual(catalog["schema"], 1)
            self.assertEqual(catalog["revision"], "sig." + catalogs.REVISION)
            for entry in catalog["entries"]:
                self.assertIn(catalogs.REVISION, entry["source"])
                self.assertTrue(entry["source"].startswith("https://bitbucket.org/bluetooth-SIG/public/src/"))
        appearances = data["bluetooth-appearance"]["entries"]
        self.assertEqual(len(appearances), 342)
        self.assertTrue(all(entry["code"] == entry["categoryCode"] * 64 + entry["subcategory"] for entry in appearances))
        self.assertEqual(len(data["bluetooth-ad-types"]["entries"]), 51)
        self.assertEqual(sum(entry["code"] == 16 for entry in data["bluetooth-ad-types"]["entries"]), 2)


if __name__ == "__main__":
    unittest.main()
