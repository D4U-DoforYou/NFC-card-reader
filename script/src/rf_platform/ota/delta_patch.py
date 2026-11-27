"""Build restart-safe XOR patches for the CH572D page updater."""
from __future__ import annotations

import math
import struct
import zlib

PAGE_SIZE = 4096
ERASED_PAGE = struct.pack("<I", 0xF3F9BDA9) * (PAGE_SIZE // 4)
APP_SIZE = 176 * 1024
PATCH_PAYLOAD_SIZE = 40 * 1024
PATCH_MAGIC = 0x31504652
PATCH_VERSION = 1
HEADER = struct.Struct("<IHHIIIIII")


def _xor_runs(old_page: bytes, new_page: bytes):
    index = 0
    while index < PAGE_SIZE:
        while index < PAGE_SIZE and old_page[index] == new_page[index]:
            index += 1
        start = index
        while index < PAGE_SIZE and old_page[index] != new_page[index]:
            index += 1
        if start != index:
            yield start, old_page[start:index], new_page[start:index]


def build_patch(base: bytes, target: bytes) -> bytes:
    if not base or not target:
        raise ValueError("base and target images must be non-empty")
    if len(base) > APP_SIZE or len(target) > APP_SIZE:
        raise ValueError("image exceeds the 176 KB APP partition")

    page_count = math.ceil(max(len(base), len(target)) / PAGE_SIZE)
    records = bytearray()
    changed_pages = 0
    for page_index in range(page_count):
        offset = page_index * PAGE_SIZE
        old_page = base[offset:offset + PAGE_SIZE]
        old_page += ERASED_PAGE[len(old_page):]
        new_page = target[offset:offset + PAGE_SIZE]
        new_page += ERASED_PAGE[len(new_page):]
        runs = list(_xor_runs(old_page, new_page))
        if not runs:
            continue
        if page_index > 0xFFFF or len(runs) > 0xFFFF:
            raise ValueError("patch has too many page records")
        records.extend(struct.pack("<HH", page_index, len(runs)))
        for run_offset, old_bytes, new_bytes in runs:
            records.extend(struct.pack("<HH", run_offset, len(old_bytes)))
            records.extend(a ^ b for a, b in zip(old_bytes, new_bytes))
        changed_pages += 1

    header = HEADER.pack(
        PATCH_MAGIC, PATCH_VERSION, PAGE_SIZE, len(base), len(target),
        changed_pages, zlib.crc32(base) & 0xFFFFFFFF,
        zlib.crc32(target) & 0xFFFFFFFF, zlib.crc32(records) & 0xFFFFFFFF,
    )
    patch = header + records
    if len(patch) > PATCH_PAYLOAD_SIZE:
        raise ValueError(
            f"patch is {len(patch)} bytes; limit is {PATCH_PAYLOAD_SIZE} "
            "bytes because one 4 KB Patch block is reserved for recovery"
        )
    return patch
