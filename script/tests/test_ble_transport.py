from types import SimpleNamespace
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from rf_platform.transport.ble_gatt import (
    DEVICE_NAME_PREFIXES,
    SERVICE_UUID,
    _is_rf_platform_device,
)


class BleDeviceNameTests(unittest.TestCase):
    def test_supported_firmware_prefixes(self):
        self.assertEqual(
            DEVICE_NAME_PREFIXES,
            ("D4U-NFCA01-", "D4U-NFCB01-"),
        )
        for name in (
            "D4U-NFCA01-001122334455",
            "D4U-NFCB01-001122334455",
        ):
            with self.subTest(name=name):
                self.assertTrue(name.startswith(DEVICE_NAME_PREFIXES))

    def test_accepts_supported_names_and_name_missing_service_advertisement(self):
        for name in (
            "D4U-NFCA01-001122334455",
            "D4U-NFCB01-001122334455",
        ):
            with self.subTest(name=name):
                advertisement = SimpleNamespace(
                    local_name=name, service_uuids=[]
                )
                device = SimpleNamespace(name=None)
                self.assertTrue(_is_rf_platform_device(device, advertisement))

        advertisement = SimpleNamespace(
            local_name=None, service_uuids=[SERVICE_UUID]
        )
        device = SimpleNamespace(name=None)
        self.assertTrue(_is_rf_platform_device(device, advertisement))

    def test_accepts_name_reported_by_scanner_device(self):
        device = SimpleNamespace(name="D4U-NFCB01-001122334455")
        advertisement = SimpleNamespace(local_name=None, service_uuids=[])
        self.assertTrue(_is_rf_platform_device(device, advertisement))

    def test_accepts_product_name_when_advertisement_name_differs(self):
        device = SimpleNamespace(name="D4U-NFCA01-B3A6")
        advertisement = SimpleNamespace(
            local_name="689DD279B3A4", service_uuids=[SERVICE_UUID]
        )
        self.assertTrue(_is_rf_platform_device(device, advertisement))

    def test_rejects_unrelated_name_even_if_service_matches(self):
        device = SimpleNamespace(name="Other product")
        advertisement = SimpleNamespace(
            local_name="Other product", service_uuids=[SERVICE_UUID]
        )
        self.assertFalse(_is_rf_platform_device(device, advertisement))


if __name__ == "__main__":
    unittest.main()
