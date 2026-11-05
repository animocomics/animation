#!/usr/bin/env python3
"""Bounded RFB 3.8 None-security/ZRLE framebuffer smoke client for the VM build."""
import hashlib
import os
import socket
from contextlib import contextmanager
import struct
import sys
import time
import zlib


ZRLE_ENCODING = 16
MAX_ZRLE_COMPRESSED_BYTES = 16 * 1024 * 1024
MAX_ZRLE_DECOMPRESSED_BYTES = 16 * 1024 * 1024


class VncSessionError(RuntimeError):
    """An established RFB session failed; reconnecting a serial relay is unsafe."""


class ZrleStream:
    def __init__(self, data):
        self.data = data
        self.offset = 0

    def read(self, length):
        end = self.offset + length
        if length < 0 or end > len(self.data):
            raise RuntimeError("Truncated ZRLE tile")
        output = self.data[self.offset:end]
        self.offset = end
        return output

    def byte(self):
        return self.read(1)[0]

    def pixels(self, count):
        return [self.read(3) for _ in range(count)]


def log(message):
    print(message, flush=True)


def trace(message):
    if os.environ.get("VNC_SMOKE_TRACE") == "1":
        log(f"NOMREH_VNC_TRACE {message}")


def receive_exactly(connection, length):
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            raise RuntimeError("VNC connection closed")
        data.extend(chunk)
    return bytes(data)


@contextmanager
def vnc_connection(port, read_timeout, reverse, unix_path=""):
    if unix_path:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(4)
            connection.connect(unix_path)
            yield connection
        return
    if not reverse:
        with socket.create_connection(("127.0.0.1", port), timeout=4) as connection:
            yield connection
        return
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(4)
        listener.settimeout(20)
        connection, address = listener.accept()
        with connection:
            if address[0] != "127.0.0.1":
                raise RuntimeError("Reverse VNC connection was not loopback")
            yield connection


def read_rle_length(stream, remaining):
    length = 0
    while True:
        current = stream.byte()
        length += current
        if current != 255:
            break
        if length > remaining:
            raise RuntimeError("Oversized ZRLE run")
    length += 1
    if length > remaining:
        raise RuntimeError("ZRLE run exceeds its tile")
    return length


def decode_zrle_tile(stream, width, height):
    size = width * height
    subencoding = stream.byte()
    if subencoding == 0:
        return stream.read(size * 3)
    if subencoding == 1:
        return stream.read(3) * size
    if 2 <= subencoding <= 16:
        palette = stream.pixels(subencoding)
        bits = 1 if subencoding <= 2 else 2 if subencoding <= 4 else 4
        mask = (1 << bits) - 1
        output = bytearray()
        for _row in range(height):
            packed = stream.read((width * bits + 7) // 8)
            for column in range(width):
                bit = column * bits
                shift = 8 - bits - (bit % 8)
                index = (packed[bit // 8] >> shift) & mask
                if index >= len(palette):
                    raise RuntimeError("Invalid ZRLE palette index")
                output.extend(palette[index])
        return bytes(output)
    if subencoding == 128:
        output = bytearray()
        while len(output) < size * 3:
            pixel = stream.read(3)
            remaining = size - len(output) // 3
            output.extend(pixel * read_rle_length(stream, remaining))
        return bytes(output)
    if 130 <= subencoding <= 255:
        palette = stream.pixels(subencoding - 128)
        output = bytearray()
        while len(output) < size * 3:
            encoded = stream.byte()
            index = encoded & 127
            if index >= len(palette):
                raise RuntimeError("Invalid ZRLE RLE palette index")
            remaining = size - len(output) // 3
            length = read_rle_length(stream, remaining) if encoded & 128 else 1
            output.extend(palette[index] * length)
        return bytes(output)
    raise RuntimeError(f"Unsupported ZRLE tile subencoding {subencoding}")


def decode_zrle_rectangle(payload, width, height):
    decompressor = zlib.decompressobj()
    try:
        data = decompressor.decompress(payload, MAX_ZRLE_DECOMPRESSED_BYTES + 1)
    except zlib.error as error:
        raise RuntimeError("Invalid ZRLE compressed data") from error
    if len(data) > MAX_ZRLE_DECOMPRESSED_BYTES or decompressor.unconsumed_tail or not decompressor.eof or decompressor.unused_data:
        raise RuntimeError("Invalid or oversized ZRLE rectangle")
    stream = ZrleStream(data)
    output = bytearray(width * height * 4)
    for tile_y in range(0, height, 64):
        tile_height = min(64, height - tile_y)
        for tile_x in range(0, width, 64):
            tile_width = min(64, width - tile_x)
            tile = decode_zrle_tile(stream, tile_width, tile_height)
            for row in range(tile_height):
                for column in range(tile_width):
                    source = (row * tile_width + column) * 3
                    target = ((tile_y + row) * width + tile_x + column) * 4
                    output[target:target + 3] = tile[source:source + 3]
    return output


def request_rgb_pixel_format(connection):
    # Match noVNC: 32-bit little-endian true colour with R/G/B in the low three
    # bytes. ZRLE then carries three-byte CPIXEL values in display RGB order.
    connection.sendall(struct.pack(
        ">BBBBBBBBHHHBBBBBB",
        0, 0, 0, 0, 32, 24, 0, 1,
        255, 255, 255, 0, 8, 16, 0, 0, 0,
    ))


def capture_connected(connection, output_path, read_timeout):
    connection.settimeout(read_timeout)
    trace("connected")
    version = receive_exactly(connection, 12)
    trace(f"version={version.decode('ascii').strip()}")
    if not version.startswith(b"RFB 003.") or not version.endswith(b"\n"):
        raise RuntimeError("Not an RFB 3.x server")
    connection.sendall(b"RFB 003.008\n")
    count = receive_exactly(connection, 1)[0]
    if not count:
        raise RuntimeError("VNC server offered no security type")
    if 1 not in receive_exactly(connection, count):
        raise RuntimeError("VNC None security is unavailable")
    connection.sendall(b"\x01")
    if struct.unpack(">I", receive_exactly(connection, 4))[0] != 0:
        raise RuntimeError("VNC security negotiation failed")
    trace("security-complete")
    connection.sendall(b"\x01")
    initial = receive_exactly(connection, 24)
    width, height = struct.unpack(">HH", initial[:4])
    bits, _depth, _big_endian, true_color = struct.unpack(">BBBB", initial[4:8])
    name_length = struct.unpack(">I", initial[20:24])[0]
    if name_length > 4096:
        raise RuntimeError("Invalid VNC desktop name length")
    receive_exactly(connection, name_length)
    trace("server-init-received")
    if not width or not height or width > 4096 or height > 4096 or bits != 32 or not true_color:
        raise RuntimeError(f"Unsupported VNC framebuffer {width}x{height}x{bits}")
    request_rgb_pixel_format(connection)
    # Offer the same compressed encoding implemented by the real noVNC client.
    # Raw-only full-desktop updates were too large for the emulated serial relay.
    connection.sendall(struct.pack(">BBHi", 2, 0, 1, ZRLE_ENCODING))
    connection.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))
    trace(f"update-requested width={width} height={height} encoding=ZRLE")

    rgb = bytearray(width * height * 3)
    deadline = time.monotonic() + read_timeout
    update = 0
    while True:
        message_type = receive_exactly(connection, 1)[0]
        if message_type == 0:
            _padding, rectangles = struct.unpack(">BH", receive_exactly(connection, 3))
        elif message_type == 2:
            continue
        elif message_type == 3:
            header = receive_exactly(connection, 7)
            length = struct.unpack(">I", header[3:7])[0]
            if length > 1024 * 1024:
                raise RuntimeError("Oversized VNC text message")
            receive_exactly(connection, length)
            continue
        else:
            raise RuntimeError(f"Unsupported VNC server message {message_type}")
        if rectangles > 128:
            raise RuntimeError("VNC returned too many framebuffer rectangles")
        update += 1
        trace(f"framebuffer-update number={update} rectangles={rectangles}")
        for rectangle_index in range(rectangles):
            x, y, w, h, encoding = struct.unpack(">HHHHi", receive_exactly(connection, 12))
            trace(f"rectangle={rectangle_index + 1}/{rectangles} x={x} y={y} width={w} height={h} encoding={encoding}")
            if x + w > width or y + h > height or not w or not h:
                raise RuntimeError("Invalid VNC rectangle geometry")
            if encoding == ZRLE_ENCODING:
                compressed_length = struct.unpack(">I", receive_exactly(connection, 4))[0]
                if not compressed_length or compressed_length > MAX_ZRLE_COMPRESSED_BYTES:
                    raise RuntimeError("Invalid ZRLE rectangle length")
                raw = decode_zrle_rectangle(receive_exactly(connection, compressed_length), w, h)
            else:
                raise RuntimeError(f"VNC server did not honour ZRLE encoding ({encoding})")
            for row in range(h):
                for column in range(w):
                    source = (row * w + column) * 4
                    target = ((y + row) * width + x + column) * 3
                    rgb[target:target + 3] = raw[source:source + 3]

        colors = set()
        minimum, maximum = 255, 0
        for offset in range(0, len(rgb), 3):
            red, green, blue = rgb[offset:offset + 3]
            if len(colors) < 4096:
                colors.add((red << 16) | (green << 8) | blue)
            luminance = round((red + green + blue) / 3)
            minimum, maximum = min(minimum, luminance), max(maximum, luminance)
        if len(colors) >= 16 and maximum - minimum >= 24:
            ppm = f"P6\n{width} {height}\n255\n".encode("ascii") + bytes(rgb)
            digest = hashlib.sha256(ppm).hexdigest()
            if output_path:
                with open(output_path, "wb") as output:
                    os.chmod(output_path, 0o600)
                    output.write(ppm)
            return width, height, len(colors), minimum, maximum, digest, len(ppm)
        trace(f"framebuffer-wait update={update} colors={len(colors)} luminance_range={maximum - minimum}")
        if time.monotonic() >= deadline:
            raise RuntimeError(f"framebuffer still uniform after {update} updates (colors={len(colors)})")
        # The initial frame can precede application rendering. Keep the one real
        # serial/RFB session open and request incremental frames like noVNC does.
        connection.sendall(struct.pack(">BBHHHH", 3, 1, 0, 0, width, height))


def capture(port, output_path, read_timeout, reverse, unix_path=""):
    with vnc_connection(port, read_timeout, reverse, unix_path) as connection:
        try:
            return capture_connected(connection, output_path, read_timeout)
        except (OSError, RuntimeError, ValueError) as error:
            raise VncSessionError(str(error)[:160]) from error


def main():
    port = int(sys.argv[1])
    output_path = sys.argv[2] if len(sys.argv) > 2 else ""
    attempts = int(os.environ.get("VNC_SMOKE_ATTEMPTS", "60"))
    read_timeout = int(os.environ.get("VNC_READ_TIMEOUT_MS", "15000")) / 1000
    reverse = os.environ.get("VNC_SMOKE_REVERSE") == "1"
    unix_path = os.environ.get("VNC_SMOKE_UNIX", "")
    if not 1024 <= port <= 65535:
        raise RuntimeError("Invalid VNC port")
    trace(f"client-begin port={port} attempts={attempts} reverse={reverse} unix={bool(unix_path)} read_timeout_ms={int(read_timeout * 1000)}")
    last_error = None
    for attempt in range(1, attempts + 1):
        if attempt == 1 or attempt % 5 == 0:
            log(f"NOMREH_VNC_ATTEMPT_BEGIN {attempt}")
        try:
            width, height, colors, minimum, maximum, digest, size = capture(port, output_path, read_timeout, reverse, unix_path)
            log(f"NOMREH_VNC_FRAMEBUFFER_PASS width={width} height={height} colors={colors} luminance_range={maximum - minimum} sha256={digest} bytes={size}")
            return
        except (OSError, RuntimeError, ValueError) as error:
            last_error = error
            if unix_path or attempt == 1 or attempt % 15 == 0:
                log(f"NOMREH_VNC_FRAMEBUFFER_WAIT attempt={attempt} error={str(error)[:160]}")
            if unix_path and isinstance(error, VncSessionError):
                raise
        time.sleep(1)
    raise last_error or RuntimeError("VNC framebuffer was not available")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"NOMREH_VNC_FRAMEBUFFER_ERROR {error}")
        sys.exit(1)
