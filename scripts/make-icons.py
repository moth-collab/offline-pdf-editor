"""Generate the application icon (PNG + multi-size ICO) with Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "assets" / "icons"
FONT = Path(__file__).resolve().parents[1] / "assets" / "fonts" / "NotoSans-Bold.ttf"


def draw(size: int = 1024) -> Image.Image:
    s = size / 1024
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # rounded square with vertical gradient (brand orange)
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / size
        gd.line([(0, y), (size, y)], fill=(int(245 - 20 * t), int(120 - 45 * t), int(30 - 10 * t), 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40 * s, 40 * s, 984 * s, 984 * s], radius=200 * s, fill=255)
    im.paste(grad, (0, 0), mask)
    # document sheet with folded corner
    x0, y0, x1, y1, fold = 270 * s, 180 * s, 754 * s, 830 * s, 150 * s
    d.polygon([(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)], fill=(255, 255, 255, 255))
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(255, 214, 180, 255))
    # text lines
    for i, w in enumerate((0.78, 0.62, 0.70)):
        yy = (300 + i * 70) * s
        d.rounded_rectangle([330 * s, yy, (330 + 380 * w) * s, yy + 26 * s], radius=13 * s, fill=(232, 89, 12, 90))
    # "PDF" label
    font = ImageFont.truetype(str(FONT), int(190 * s)) if FONT.exists() else ImageFont.load_default()
    d.rounded_rectangle([200 * s, 560 * s, 824 * s, 790 * s], radius=40 * s, fill=(200, 60, 10, 255))
    tw = d.textlength("PDF", font=font)
    d.text(((size - tw) / 2, 565 * s), "PDF", font=font, fill=(255, 255, 255, 255))
    return im


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw(1024)
    big.save(OUT / "icon.png")
    big.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")
    big.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("icons written to", OUT)
