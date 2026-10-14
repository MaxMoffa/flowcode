"""Draws the Android themed-icon layer (ic_launcher_monochrome.png in every
mipmap density) from the logo geometry in src/assets/flowcode-icon.svg:
the frog's head as one opaque silhouette with the eyes and the prompt cut
out, kept small enough for themed-icon padding. app-icon.svg (the colored icon)
uses the same placement (S and center below). Run from this folder:
    python monochrome.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

RES = Path(__file__).resolve().parent.parent / "gen/android/app/src/main/res"
S = 0.0722  # logo units (1024) -> dp on the 108 dp adaptive canvas
SS = 16  # supersampling, px per dp


def X(x):
    return 54 + (x - 512) * S


def Y(y):
    return 56 + (y - 547) * S


def draw():
    im = Image.new("L", (108 * SS, 108 * SS), 0)
    d = ImageDraw.Draw(im)

    def circle(cx, cy, r, v):
        d.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=v)

    circle(X(340), Y(400), 135 * S, 255)
    circle(X(684), Y(400), 135 * S, 255)
    d.ellipse([(X(512) - 360 * S) * SS, (Y(610) - 220 * S) * SS, (X(512) + 360 * S) * SS, (Y(610) + 220 * S) * SS], fill=255)
    circle(X(340), Y(393), 85 * S, 0)
    circle(X(684), Y(393), 85 * S, 0)
    circle(X(362), Y(408), 45 * S, 255)
    circle(X(706), Y(408), 45 * S, 255)
    w = 44 * S * SS
    chevron = [(X(396) * SS, Y(575) * SS), (X(472) * SS, Y(632) * SS), (X(396) * SS, Y(689) * SS)]
    underscore = [(X(526) * SS, Y(689) * SS), (X(636) * SS, Y(689) * SS)]
    d.line(chevron, fill=0, width=int(w), joint="curve")
    d.line(underscore, fill=0, width=int(w))
    for px, py in [chevron[0], chevron[2], *underscore]:  # round caps
        d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=0)
    return im


def main():
    alpha = draw()
    for folder, px in [("mdpi", 108), ("hdpi", 162), ("xhdpi", 216), ("xxhdpi", 324), ("xxxhdpi", 432)]:
        out = Image.new("RGBA", (px, px), (255, 255, 255, 255))
        out.putalpha(alpha.resize((px, px), Image.LANCZOS))
        out.save(RES / f"mipmap-{folder}" / "ic_launcher_monochrome.png")


if __name__ == "__main__":
    main()
