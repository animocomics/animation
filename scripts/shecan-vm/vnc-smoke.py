#!/usr/bin/env python3
"""Bounded RFB 3.8 None-security/raw-framebuffer smoke client for the VM build."""
import hashlib
import os
import socket
from contextlib import contextmanager
import struct
import sys
import time


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


def capture(port, output_path, read_timeout, reverse, unix_path=""):
    with vnc_connection(port, read_timeout, reverse, unix_path) as connection:
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
        bits, _depth, big_endian, true_color = struct.unpack(">BBBB", initial[4:8])
        red_shift, green_shift, blue_shift = initial[14:17]
        name_length = struct.unpack(">I", initial[20:24])[0]
        if name_length > 4096:
            raise RuntimeError("Invalid VNC desktop name length")
        receive_exactly(connection, name_length)
        trace("server-init-received")
        if not width or not height or width > 4096 or height > 4096 or bits != 32 or not true_color:
            raise RuntimeError(f"Unsupported VNC framebuffer {width}x{height}x{bits}")
        connection.sendall(struct.pack(">BBHi", 2, 0, 1, 0))
        connection.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))
        trace(f"update-requested width={width} height={height}")
        while True:
            message_type = receive_exactly(connection, 1)[0]
            if message_type == 0:
                _padding, rectangles = struct.unpack(">BH", receive_exactly(connection, 3))
                break
            if message_type == 2:
                continue
            if message_type == 3:
                header = receive_exactly(connection, 7)
                length = struct.unpack(">I", header[3:7])[0]
                if length > 1024 * 1024:
                    raise RuntimeError("Oversized VNC text message")
                receive_exactly(connection, length)
                continue
            raise RuntimeError(f"Unsupported VNC server message {message_type}")
        if not rectangles or rectangles > 128:
            raise RuntimeError("VNC returned no usable framebuffer rectangles")
        trace(f"framebuffer-update rectangles={rectangles}")
        rgb = bytearray(width * height * 3)
        colors = set()
        minimum, maximum = 255, 0
        for rectangle_index in range(rectangles):
            x, y, w, h, encoding = struct.unpack(">HHHHi", receive_exactly(connection, 12))
            if unix_path:
                trace(f"rectangle={rectangle_index + 1}/{rectangles} x={x} y={y} width={w} height={h} encoding={encoding}")
            if encoding != 0 or x + w > width or y + h > height or not w or not h:
                raise RuntimeError("Unsupported VNC rectangle")
            raw = receive_exactly(connection, w * h * 4)
            for row in range(h):
                for column in range(w):
                    source = (row * w + column) * 4
                    value = int.from_bytes(raw[source:source + 4], "big" if big_endian else "little")
                    red = (value >> red_shift) & 255
                    green = (value >> green_shift) & 255
                    blue = (value >> blue_shift) & 255
                    target = ((y + row) * width + x + column) * 3
                    rgb[target:target + 3] = bytes((red, green, blue))
                    if len(colors) < 4096:
                        colors.add((red << 16) | (green << 8) | blue)
                    luminance = round((red + green + blue) / 3)
                    minimum, maximum = min(minimum, luminance), max(maximum, luminance)
        ppm = f"P6\n{width} {height}\n255\n".encode("ascii") + bytes(rgb)
        digest = hashlib.sha256(ppm).hexdigest()
        if output_path:
            with open(output_path, "wb") as output:
                os.chmod(output_path, 0o600)
                output.write(ppm)
        return width, height, len(colors), minimum, maximum, digest, len(ppm)


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
            if colors < 16 or maximum - minimum < 24:
                last_error = RuntimeError(f"framebuffer still uniform (colors={colors})")
                if attempt == 1 or attempt % 5 == 0:
                    log(f"NOMREH_VNC_FRAMEBUFFER_WAIT attempt={attempt} colors={colors} luminance_range={maximum - minimum} width={width} height={height}")
            else:
                log(f"NOMREH_VNC_FRAMEBUFFER_PASS width={width} height={height} colors={colors} luminance_range={maximum - minimum} sha256={digest} bytes={size}")
                return
        except (OSError, RuntimeError, ValueError) as error:
            last_error = error
            if unix_path or attempt == 1 or attempt % 15 == 0:
                log(f"NOMREH_VNC_FRAMEBUFFER_WAIT attempt={attempt} error={str(error)[:160]}")
        time.sleep(1)
    raise last_error or RuntimeError("VNC framebuffer was not available")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"NOMREH_VNC_FRAMEBUFFER_ERROR {error}")
        sys.exit(1)
