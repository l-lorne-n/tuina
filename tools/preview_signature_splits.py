from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


SOURCE_IMAGES = [
    Path(
        r"L:\xwechat_files\wxid_tny6w0p9f7e432_6660\temp\RWTemp\2026-07\9e20f478899dc29eb19741386f9343c8\20f925586a1f430ec9e9d23aa6136345.jpg"
    ),
    Path(
        r"L:\xwechat_files\wxid_tny6w0p9f7e432_6660\temp\RWTemp\2026-07\9e20f478899dc29eb19741386f9343c8\053a4ac74507659305185e182c33b568.jpg"
    ),
    Path(
        r"L:\xwechat_files\wxid_tny6w0p9f7e432_6660\temp\RWTemp\2026-07\9e20f478899dc29eb19741386f9343c8\32d9db6d3b9dc21b1fac5fded7fc7dac.jpg"
    ),
]


def fit_thumb(image: Image.Image, width: int = 260, height: int = 92) -> Image.Image:
    thumb = ImageOps.contain(image, (width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (width, height), "white")
    canvas.paste(thumb, ((width - thumb.width) // 2, (height - thumb.height) // 2))
    return canvas


def main() -> None:
    out_dir = Path("data/signature_split_preview")
    out_dir.mkdir(parents=True, exist_ok=True)

    imgs = [ImageOps.exif_transpose(Image.open(path)).convert("RGB") for path in SOURCE_IMAGES]

    # Coordinates are quick manual calibration on EXIF-oriented images.
    specs = [
        ("第一图-左列", imgs[0], 10, (360, 300, 760, 380), 116),
        ("第一图-中列", imgs[0], 10, (1240, 295, 1700, 390), 116),
        ("第一图-右列", imgs[0], 8, (1670, 300, 2050, 392), 116),
        ("第二图-左列", imgs[1], 10, (110, 125, 420, 220), 86),
        ("第二图-右列", imgs[1], 10, (455, 125, 805, 220), 86),
        ("第三图-左列", imgs[2], 10, (980, 620, 1720, 760), 158),
        ("第三图-中列", imgs[2], 10, (2550, 620, 3300, 760), 158),
        ("第三图-右列", imgs[2], 6, (3300, 620, 3860, 760), 158),
    ]

    thumbs: list[tuple[str, Image.Image]] = []
    for label, image, count, box, step in specs:
        x1, y1, x2, y2 = box
        for index in range(count):
            crop = image.crop((x1, y1 + index * step, x2, y2 + index * step))
            crop_path = out_dir / f"{label}_{index + 1:02d}.jpg"
            crop.save(crop_path, quality=92)
            thumbs.append((f"{label} {index + 1}", fit_thumb(crop)))

    cols = 4
    cell_w = 300
    cell_h = 128
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), "#f5f7f8")
    draw = ImageDraw.Draw(sheet)
    for idx, (label, thumb) in enumerate(thumbs):
        col = idx % cols
        row = idx // cols
        x = col * cell_w + 20
        y = row * cell_h + 28
        sheet.paste(thumb, (x, y))
        draw.text((x, y - 20), label, fill=(30, 42, 51))

    preview_path = out_dir / "signature_split_preview.jpg"
    sheet.save(preview_path, quality=92)
    print(preview_path.resolve())


if __name__ == "__main__":
    main()
