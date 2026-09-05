#!/usr/bin/env python3
"""Tray icons drawn as Yuri's orb, not as abstract rings.

    python3 desktop/assets/make-icons.py desktop/assets

Committed because the PNGs alone are not a source of truth: without this you
cannot retune a state, and the first attempt DID need retuning -- see the note
on depth weighting below.

The orb in the app is a Fibonacci sphere -- a golden-angle spiral of points --
rendered as ~1500 translucent squares with per-point depth attenuation
(frontend/lib/orb.ts:64-74 and components/shell/Orb.tsx). These icons use the
same generator at a size a 16pt menu-bar slot can hold, so the tray reads as
the same object rather than a different piece of iconography.

macOS template images carry only black plus alpha and are tinted by the
system, so ALPHA is the only channel available. That suits a point cloud:
density and per-point brightness both encode state without needing colour.

    asleep     a sparse, dim cloud -- present but not listening
    listening  the full cloud at a resting brightness
    thinking   the full cloud, a touch brighter with a faint core --
               composing a reply, between listening and speaking
    speaking   the full cloud, brighter still
    working    brighter still, with a denser core
    needs-you  the full cloud plus a solid centre, which is the one state
               that has to read instantly at 16pt
"""
import math
import struct
import sys
import zlib

SIZE = 32          # @2x of a 16pt slot
R = 13.2           # sphere radius in px, leaving a little breathing room


def sphere(n):
    """The app's own generator, ported verbatim from frontend/lib/orb.ts."""
    out = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 0.0 if n == 1 else 1 - (i / (n - 1)) * 2
        r = math.sqrt(max(0.0, 1 - y * y))
        th = ga * i
        out.append((math.cos(th) * r, y, math.sin(th) * r))
    return out


def render(points, gain, core, centre_dot):
    """One icon as an RGBA pixel grid.

    `gain` scales every point's alpha; `core` adds a soft central glow the way
    the app's orb brightens toward its middle; `centre_dot` is the solid mark
    that makes needs-you unmistakable.
    """
    acc = [[0.0] * SIZE for _ in range(SIZE)]
    c = (SIZE - 1) / 2.0

    for (x, y, z) in points:
        # Depth attenuation, weighted hard toward the front face.
        #
        # The obvious version -- a gentle 0.34..1.0 ramp, like the app's own
        # orb -- looked wrong at this size, and looking at it was the only way
        # to find out. A sphere's silhouette carries the HIGHEST projected
        # point density, so a rim that is still ~67% bright reads as a fuzzy
        # ring with noise inside it. The app's orb escapes this by having
        # ~1500 translucent points across a few hundred pixels; at 32px there
        # are ~200 and the rim wins. Squashing the far hemisphere towards zero
        # turns the ring back into a ball.
        depth = (0.14 + 0.86 * ((z + 1.0) / 2.0)) ** 2.3
        px, py = c + x * R, c - y * R
        ix, iy = int(math.floor(px)), int(math.floor(py))
        fx, fy = px - ix, py - iy
        a = gain * depth
        # Bilinear splat, so a 1px point at a fractional position does not
        # snap to a grid and turn the spiral into stair-steps.
        for dx, dy, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)),
                          (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            jx, jy = ix + dx, iy + dy
            if 0 <= jx < SIZE and 0 <= jy < SIZE:
                acc[jy][jx] += a * w

    if core:
        for yy in range(SIZE):
            for xx in range(SIZE):
                d = math.hypot(xx - c, yy - c)
                if d < R * 0.78:
                    acc[yy][xx] += core * (1.0 - d / (R * 0.78)) ** 1.7

    if centre_dot:
        for yy in range(SIZE):
            for xx in range(SIZE):
                d = math.hypot(xx - c, yy - c)
                if d <= 3.4:
                    acc[yy][xx] = 1.0
                elif d <= 4.4:          # one-pixel gap, so the dot reads as a
                    acc[yy][xx] = 0.0   # separate mark and not a bright blob

    rows = []
    for yy in range(SIZE):
        row = []
        for xx in range(SIZE):
            a = acc[yy][xx]
            row.append((0, 0, 0, max(0, min(255, int(round(a * 255))))))
        rows.append(row)
    return rows


def write_png(path, rows):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    hdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)   # 8-bit RGBA
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", hdr)
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


# n, gain, core, centre_dot -- fewer points AND less gain for asleep, so it
# reads as quiet rather than merely faint.
STATES = {
    "asleep":    (80,  0.55, 0.00, False),
    "listening": (190, 0.80, 0.06, False),
    # Same point count as listening -- brighter, with a faint core -- so she
    # reads as composing a reply, not as idle and not yet as speaking.
    "thinking":  (190, 0.86, 0.14, False),
    "speaking":  (190, 0.95, 0.26, False),
    "working":   (240, 1.00, 0.46, False),
    "needs-you": (240, 1.00, 0.46, True),
}

def main(outdir):
    for name, (n, gain, core, dot) in STATES.items():
        rows = render(sphere(n), gain, core, dot)
        path = f"{outdir}/{name}Template@2x.png"
        write_png(path, rows)
        ink = sum(px[3] for row in rows for px in row) / 255.0
        lit = sum(1 for row in rows for px in row if px[3] > 8)
        print(f"  {name:11} points={n:3}  ink={ink:7.1f}  lit_px={lit:4}  -> {path}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
