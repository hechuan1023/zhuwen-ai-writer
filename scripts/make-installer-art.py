from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "build"
FONT = r"C:\Windows\Fonts\msyh.ttc"


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def paint(size, sidebar):
    w, h = size
    image = Image.new("RGB", size, "#0b1424")
    px = image.load()
    for y in range(h):
        for x in range(w):
            t = (x / max(1, w - 1)) * 0.65 + (y / max(1, h - 1)) * 0.35
            px[x, y] = (int(9 + 12 * t), int(18 + 20 * t), int(35 + 34 * t))
    draw = ImageDraw.Draw(image)
    for x in range(-h, w, 24):
        draw.line((x, 0, x + h, h), fill="#162c43", width=1)
    draw.rectangle((12, 12, w - 13, h - 13), outline="#2b6b8b", width=1)
    draw.line((18, h - 42, w - 18, h - 42), fill="#42c7d7", width=2)
    if sidebar:
        draw.text((22, 48), "铸文", fill="#e8fbff", font=font(28))
        draw.text((23, 88), "ZH U W E N", fill="#65d4df", font=font(9))
        draw.text((23, 116), "WRITE WITH", fill="#a3b9ca", font=font(10))
        draw.text((23, 134), "FOCUS", fill="#a3b9ca", font=font(10))
        draw.ellipse((w - 52, h - 72, w - 28, h - 48), outline="#65d4df", width=2)
        draw.ellipse((w - 47, h - 67, w - 33, h - 53), outline="#d9a55b", width=1)
    else:
        draw.text((18, 18), "铸文", fill="#e8fbff", font=font(18))
        draw.text((74, 23), "AI NOVEL WORKSPACE", fill="#65d4df", font=font(9))
    return image


paint((164, 314), True).save(ROOT / "installer-sidebar.bmp")
paint((150, 57), False).save(ROOT / "installer-header.bmp")
