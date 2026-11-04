#!/usr/bin/env python3
"""Backport Wine's SIO_UDP_NETRESET compatibility to the pinned Wine 9.22 DLL.

Only Wine's ws2_32.dll is patched. The genuine Shecan executable and its remote
configuration are untouched. Wine 9.22 already accepts SIO_UDP_CONNRESET; this
routes SIO_UDP_NETRESET (_WSAIOW(IOC_VENDOR, 15), 0x9800000f) to the same success
handler, matching current upstream Wine's socket.c behavior.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil
import struct

UPSTREAM_SHA256 = "0b95ac832d032340beeb90e00e32fbf252f7f0ab0630c2f90925f15709ec5afd"
DEFAULT_HANDLER_RVA = 0x79AD
DEFAULT_HANDLER_END_RVA = 0x79E4
NETRESET_SUCCESS_RVA = 0x7A90
UNSUPPORTED_HANDLER_RVA = 0x7755
EXPECTED_DEFAULT_PREFIX = bytes.fromhex("f6056cd70000010f849bfdffff")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def section_map(data: bytes) -> list[dict[str, int]]:
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise ValueError("ws2_32 is not a PE image")
    section_count = struct.unpack_from("<H", data, pe_offset + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe_offset + 20)[0]
    section_offset = pe_offset + 24 + optional_size
    sections = []
    for index in range(section_count):
        offset = section_offset + index * 40
        name = data[offset : offset + 8].rstrip(b"\0").decode("ascii")
        virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from(
            "<IIII", data, offset + 8
        )
        sections.append(
            {
                "name": name,
                "virtual_size": virtual_size,
                "virtual_address": virtual_address,
                "raw_size": raw_size,
                "raw_offset": raw_offset,
            }
        )
    return sections


def rva_offset(sections: list[dict[str, int]], rva: int, length: int = 1) -> int:
    for section in sections:
        start = section["virtual_address"]
        mapped_size = max(section["virtual_size"], section["raw_size"])
        if start <= rva and rva + length <= start + mapped_size:
            offset = section["raw_offset"] + rva - start
            if offset + length > section["raw_offset"] + section["raw_size"]:
                raise ValueError(f"RVA 0x{rva:x} is not backed by file data")
            return offset
    raise ValueError(f"RVA 0x{rva:x} is not mapped")


def rel32(instruction_rva: int, instruction_length: int, target_rva: int) -> bytes:
    displacement = target_rva - (instruction_rva + instruction_length)
    return struct.pack("<i", displacement)


def patch(data: bytes) -> bytes:
    if sha256(data) != UPSTREAM_SHA256:
        raise ValueError("ws2_32 does not match the pinned Wine 9.22 upstream hash")
    sections = section_map(data)
    default_offset = rva_offset(sections, DEFAULT_HANDLER_RVA, len(EXPECTED_DEFAULT_PREFIX))
    if data[default_offset : default_offset + len(EXPECTED_DEFAULT_PREFIX)] != EXPECTED_DEFAULT_PREFIX:
        raise ValueError("WSAIoctl default handler bytes differ from the verified original")
    block_length = rva_offset(sections, DEFAULT_HANDLER_END_RVA) - default_offset
    if block_length != 55:
        raise ValueError("unexpected WSAIoctl default-handler size")

    patched = bytearray(data)
    patched[default_offset : default_offset + block_length] = b"\x90" * block_length
    cursor = DEFAULT_HANDLER_RVA

    # cmp r12d, 0x9800000f (SIO_UDP_NETRESET)
    compare = b"\x41\x81\xfc\x0f\x00\x00\x98"
    patched[default_offset : default_offset + len(compare)] = compare
    cursor += len(compare)

    # je the existing SIO_UDP_CONNRESET success handler.
    jump_if_equal = b"\x0f\x84" + rel32(cursor, 6, NETRESET_SUCCESS_RVA)
    jump_offset = rva_offset(sections, cursor, 6)
    patched[jump_offset : jump_offset + 6] = jump_if_equal
    cursor += 6

    # Every other unknown ioctl keeps the original unsupported-result behavior.
    jump = b"\xe9" + rel32(cursor, 5, UNSUPPORTED_HANDLER_RVA)
    jump_offset = rva_offset(sections, cursor, 5)
    patched[jump_offset : jump_offset + 5] = jump

    if sha256(bytes(patched)) == UPSTREAM_SHA256:
        raise ValueError("patch did not change ws2_32")
    return bytes(patched)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="pinned Wine 9.22 x86_64 ws2_32.dll")
    parser.add_argument("output", type=Path, help="new patched DLL; never modifies input in place")
    args = parser.parse_args()
    original = args.input.read_bytes()
    result = patch(original)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + ".tmp")
    temporary.write_bytes(result)
    shutil.copymode(args.input, temporary)
    temporary.replace(args.output)
    print(f"WINE_UDP_PATCH_OK input_sha256={UPSTREAM_SHA256} output_sha256={sha256(result)}")


if __name__ == "__main__":
    main()
