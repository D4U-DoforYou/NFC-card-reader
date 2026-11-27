import unittest
from types import SimpleNamespace

from rf_platform.nfc.iso_dep import IsoDepSession, _parse_ats


class IsoDepSessionTests(unittest.IsolatedAsyncioTestCase):
    def test_ats_fsc_and_fwi_are_parsed(self):
        self.assertEqual(_parse_ats(bytes((3, 0x08, 0x00))), (4, 256))
        self.assertEqual(_parse_ats(bytes((3, 0x05, 0x00))), (4, 64))

    async def test_large_apdu_uses_chained_i_blocks(self):
        class FakeBackend:
            def __init__(self):
                self.frames = []
                self.responses = [
                    (b"", 0),
                    (b"\xA2", 0),
                    (b"\x03\x90\x00", 0x10),
                ]

            async def raw_transceive(self, tx, **_kwargs):
                self.frames.append(bytes(tx))
                rx, error = self.responses.pop(0)
                return SimpleNamespace(
                    rx=rx,
                    rx_last_bits=0,
                    irq0=0x3E if error else 0,
                    irq1=0x41 if error else 0,
                    error=error,
                    collision=0,
                )

        backend = FakeBackend()
        session = IsoDepSession(backend)
        session.uid = b"test"
        session._active = True
        session._max_inf = 253
        apdu = bytes((index % 256 for index in range(257)))

        response = await session.exchange(session.uid, apdu)

        self.assertEqual(response, b"\x90\x00")
        self.assertEqual(len(backend.frames), 3)
        self.assertEqual(backend.frames[0][0], 0x12)
        self.assertEqual(len(backend.frames[0]), 254)
        self.assertEqual(backend.frames[0][1:], apdu[:253])
        self.assertEqual(backend.frames[1], b"\xB2")
        self.assertEqual(backend.frames[2], b"\x03" + apdu[253:])
        self.assertEqual(session._tx_block_number, 0)


if __name__ == "__main__":
    unittest.main()
