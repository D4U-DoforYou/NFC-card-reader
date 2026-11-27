import unittest

from rf_platform.core.capabilities import (
    CapabilityDescriptor,
    CapabilityRegistry,
    CapabilityRequirement,
    OperationDescriptor,
)


class Module:
    def __init__(self, descriptor):
        self.descriptor = descriptor


class CapabilityRegistryTests(unittest.TestCase):
    def test_register_and_lookup_capability(self):
        descriptor = CapabilityDescriptor(
            "org.example.nfc.ndef",
            1,
            0,
            (OperationDescriptor("read"), OperationDescriptor("write", mutating=True)),
        )
        module = Module(descriptor)
        registry = CapabilityRegistry()

        registry.register(module)

        self.assertIs(registry.get(descriptor.capability_id), module)
        self.assertTrue(descriptor.operation("write").mutating)

    def test_reject_duplicate_capability(self):
        descriptor = CapabilityDescriptor("org.example.device.info", 1, 0, ())
        registry = CapabilityRegistry()
        registry.register(Module(descriptor))

        with self.assertRaisesRegex(ValueError, "duplicate capability"):
            registry.register(Module(descriptor))

    def test_validate_device_capability_requirements(self):
        descriptor = CapabilityDescriptor(
            "org.example.display.panel",
            1,
            0,
            (OperationDescriptor("render", mutating=True),),
            (CapabilityRequirement("org.example.rf.iso_dep", 2),),
        )
        registry = CapabilityRegistry()
        registry.register(Module(descriptor))

        missing = registry.missing_requirements({"org.example.rf.iso_dep": 1})

        self.assertEqual(
            missing,
            (("org.example.display.panel", "org.example.rf.iso_dep", 2),),
        )

    def test_reject_duplicate_operations(self):
        with self.assertRaisesRegex(ValueError, "operation IDs must be unique"):
            CapabilityDescriptor(
                "org.example.nfc.scan",
                1,
                0,
                (OperationDescriptor("scan"), OperationDescriptor("scan")),
            )


if __name__ == "__main__":
    unittest.main()
