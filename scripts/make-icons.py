"""
Draws the app icons.

Previously this cropped client/public/*.png out of logo.png, a 1536x1024
banner whose mark was a raster gradient on a dark ground. That icon could not
follow the page theme and, at 32px in a light browser chrome, read as a dark
smudge.

The mark is now geometry, so it is drawn rather than sampled: two QR finder
patterns offset along the diagonal, which is the same shape client/ui/Logo.tsx
renders as SVG in the header and client/public/favicon.svg serves to browsers
that take one. Three files, one set of proportions, kept in the constants
below so a change to the mark is a change in one place.

Run it after editing those proportions:

    python3 scripts/make-icons.py

Requires Pillow, which is not a project dependency: this is a build-once
asset step, not part of `npm run build`.
"""
from PIL import Image, ImageDraw

# Matches the accent and its label in client/styles/tokens.css.
ACCENT = (43, 80, 226, 255)
INK = (255, 255, 255, 255)

# Every proportion below is a fraction of the icon's edge, so one set of
# numbers renders correctly at 32px and at 256px.
TILE_RADIUS = 0.22
# The finder patterns' outer squares, as (left, top, size).
PATTERNS = [(0.125, 0.125, 0.405), (0.47, 0.47, 0.405)]
PATTERN_RADIUS = 0.32   # of the pattern's own size
RING_WIDTH = 0.20       # of the pattern's own size
CORE = 0.31             # inner solid square, of the pattern's own size
CORE_RADIUS = 0.34      # of the core's own size
# The gap cut between the two patterns, as a multiple of the ring width.
KNOCKOUT = 2.1
# How much of the edge a maskable icon's mark may use. The safe zone is the
# middle 80%, and the mark runs corner to corner on the diagonal — so it is
# shrunk far enough that its diagonal, not its edge, fits inside that circle.
SAFE = 0.72

# Supersample everything, then downsample once: PIL's rounded_rectangle has no
# antialiasing of its own, and these are all curves.
SS = 8


def rounded(draw, box, radius, fill=None, outline=None, width=0):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def icon(size: int, maskable: bool = False) -> Image.Image:
    """
    Draws the mark. `maskable` draws the variant a platform is allowed to crop.

    A maskable icon is composited under a shape the platform chooses — a
    circle on most Android launchers — and only the middle 80% of the edge is
    guaranteed to survive. The standard tile rounds its own corners and runs
    its mark out to 87.5%, along the diagonal, which is precisely where a
    circular mask cuts. So the maskable variant fills the accent to every edge
    (its own corners would be clipped anyway) and shrinks the mark about the
    centre by SAFE. Drawn in one pass rather than pasted inset: resampling an
    inset tile with transparent surroundings leaves a visible halo at the
    corner arcs.
    """
    s = size * SS
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)

    rounded(draw, (0, 0, s - 1, s - 1), 0 if maskable else int(s * TILE_RADIUS), fill=ACCENT)

    patterns = PATTERNS if not maskable else [
        (0.5 + (left - 0.5) * SAFE, 0.5 + (top - 0.5) * SAFE, extent * SAFE)
        for left, top, extent in PATTERNS
    ]
    for index, (left, top, extent) in enumerate(patterns):
        x0, y0 = left * s, top * s
        side = extent * s
        box = (x0, y0, x0 + side, y0 + side)
        ring = max(1, int(side * RING_WIDTH))
        radius = int(side * PATTERN_RADIUS)

        # The lower pattern is cut away from the upper one by drawing its ring
        # first in the tile colour, oversized. Without it the two touch at the
        # centre and read as one blob at 32px.
        if index == 1:
            cut = int(ring * KNOCKOUT)
            rounded(draw, box, radius, outline=ACCENT, width=cut)

        rounded(draw, box, radius, outline=INK, width=ring)

        core = side * CORE
        cx, cy = x0 + (side - core) / 2, y0 + (side - core) / 2
        rounded(draw, (cx, cy, cx + core, cy + core), int(core * CORE_RADIUS), fill=INK)

    return im.resize((size, size), Image.LANCZOS)


for name, size in [
    # 256 is the header mark at 4x for anything that still wants a raster;
    # 180 is what iOS asks for; 32 is the tab, for browsers with no SVG icon.
    # 192 and 512 are what the web app manifest requires to be installable.
    ('logo-mark.png', 256), ('apple-touch-icon.png', 180), ('favicon-32.png', 32),
    ('icon-192.png', 192), ('icon-512.png', 512),
]:
    icon(size).save(f'client/public/{name}', optimize=True)
    print(name, size)

icon(512, maskable=True).save('client/public/icon-maskable-512.png', optimize=True)
print('icon-maskable-512.png', 512)
