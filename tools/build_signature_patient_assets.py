from __future__ import annotations

import json
import re
import shutil
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


ROOT_DIR = Path(__file__).resolve().parents[1]
DB_PATH = ROOT_DIR / "data" / "tuina_records.sqlite3"
OUTPUT_DIR = ROOT_DIR / "doc_patient" / "signature_patient"
DIRECTORY_DIR = OUTPUT_DIR / "directory"
SOURCE_DIR = OUTPUT_DIR / "source"
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"

SOURCE_IMAGES = {
    "book1": Path(
        r"L:\xwechat_files\wxid_tny6w0p9f7e432_6660\temp\RWTemp\2026-07\9e20f478899dc29eb19741386f9343c8\20f925586a1f430ec9e9d23aa6136345.jpg"
    ),
    "book2": Path(
        r"L:\xwechat_files\wxid_tny6w0p9f7e432_6660\temp\RWTemp\2026-07\9e20f478899dc29eb19741386f9343c8\053a4ac74507659305185e182c33b568.jpg"
    ),
    "book3": Path(
        r"L:\xwechat_files\wxid_tny6w0p9f7e432_6660\temp\RWTemp\2026-07\9e20f478899dc29eb19741386f9343c8\32d9db6d3b9dc21b1fac5fded7fc7dac.jpg"
    ),
}


@dataclass(frozen=True)
class CropSpec:
    image_key: str
    box: tuple[int, int, int, int]
    note: str


def load_patients() -> list[dict[str, Any]]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, import_order, source_area, source_seq, original_name, name, status
            FROM patients
            ORDER BY import_order ASC, id ASC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def safe_int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def row_box(x1: int, y1: int, x2: int, y2: int, step: int, index: int) -> tuple[int, int, int, int]:
    return (x1, y1 + index * step, x2, y2 + index * step)


BOOK1_ROW_BOUNDS = (
    310,
    416,
    523,
    631,
    738,
    853,
    962,
    1072,
    1181,
    1288,
    1399,
    1512,
    1626,
    1741,
    1856,
    1973,
    2091,
    2209,
    2329,
    2449,
    2568,
    2688,
    2808,
    2925,
    3046,
    3167,
    3289,
    3412,
    3536,
    3661,
    3785,
)


def book1_row_box(x1: int, x2: int, row_number: int) -> tuple[int, int, int, int]:
    index = max(1, min(30, row_number)) - 1
    return (x1, BOOK1_ROW_BOUNDS[index] + 6, x2, BOOK1_ROW_BOUNDS[index + 1] - 6)


BOOK2_TARGETED_BOXES = {
    67: (70, 110, 455, 270),
    77: (60, 1015, 480, 1138),
    78: (60, 1118, 480, 1245),
    79: (60, 1220, 480, 1345),
    80: (60, 1315, 480, 1440),
    81: (60, 1405, 480, 1530),
    82: (60, 1500, 480, 1625),
    83: (60, 1625, 480, 1745),
    84: (60, 1715, 480, 1835),
    85: (60, 1800, 480, 1919),
}


THIRD_BOOK_ROW_BOUNDS = (
    676,
    811,
    948,
    1087,
    1226,
    1378,
    1521,
    1666,
    1812,
    1960,
    2109,
    2259,
    2410,
    2564,
    2718,
    2874,
    3033,
    3194,
    3357,
    3523,
    3690,
    3861,
    4033,
    4208,
    4385,
    4563,
    4742,
    4925,
    5109,
    5297,
    5485,
)


def third_book_row_box(x1: int, x2: int, row_number: int) -> tuple[int, int, int, int]:
    index = max(1, min(30, row_number)) - 1
    return (x1, THIRD_BOOK_ROW_BOUNDS[index] + 8, x2, THIRD_BOOK_ROW_BOUNDS[index + 1] - 8)


def crop_spec_for_patient(patient: dict[str, Any]) -> CropSpec | None:
    order = int(patient["import_order"])
    source_area = str(patient.get("source_area") or "")
    source_seq = safe_int(patient.get("source_seq"))

    if source_seq and 6 <= order <= 20:
        return CropSpec("book1", book1_row_box(300, 835, source_seq), "第一本左侧-修正")
    if source_seq and order in {33, 35}:
        return CropSpec("book1", book1_row_box(1160, 1835, source_seq), "第一本中间-修正")
    if source_seq and 36 <= order <= 55:
        return CropSpec("book1", book1_row_box(1160, 1835, source_seq), "第一本中间-修正")

    if source_area == "左侧" and source_seq:
        return CropSpec("book1", row_box(330, 292, 805, 392, 116, source_seq - 1), "第一本左侧")
    if source_area == "中间" and source_seq:
        return CropSpec("book1", row_box(1230, 292, 1725, 400, 116, source_seq - 1), "第一本中间")
    if source_area == "右上角" and source_seq:
        return CropSpec("book1", row_box(1660, 292, 2290, 400, 116, source_seq - 1), "第一本右上角")

    if order in BOOK2_TARGETED_BOXES:
        return CropSpec("book2", BOOK2_TARGETED_BOXES[order], "第二本左列-修正")
    if 67 <= order <= 85:
        return CropSpec("book2", row_box(92, 120, 430, 222, 86, order - 67), "第二本左列")
    if 86 <= order <= 96:
        return CropSpec("book2", row_box(440, 120, 820, 222, 86, order - 86), "第二本右列")

    if order == 97:
        return CropSpec("book3", (850, 435, 1680, 570), "第三本前手写补充-王煜宸")
    if order == 98:
        return CropSpec("book3", (850, 245, 1680, 425), "第三本前手写补充-刘佳泽")

    if source_area == "第三本推拿人名.xlsx" and source_seq:
        if 136 <= order <= 150:
            return CropSpec("book3", third_book_row_box(2200, 3500, source_seq - 31), "第三本中列-修正")
        if 151 <= order <= 157:
            return CropSpec("book3", third_book_row_box(2200, 3920, source_seq - 31), "第三本中列-修正")
        if order == 158:
            return CropSpec("book3", (2920, 635, 4100, 775), "第三本右列-修正")
        if order == 159:
            return CropSpec("book3", (2920, 760, 4100, 920), "第三本右列-修正")
        if order == 160:
            return CropSpec("book3", (2920, 895, 4100, 1070), "第三本右列-修正")
        if order == 161:
            return CropSpec("book3", (3000, 990, 4100, 1210), "第三本右列-修正")
        if order == 162:
            return CropSpec("book3", (3000, 1145, 4100, 1380), "第三本右列-修正")
        if order == 163:
            return CropSpec("book3", (3000, 1335, 4100, 1548), "第三本右列-修正")
        if 2 <= source_seq <= 31:
            return CropSpec("book3", third_book_row_box(850, 2050, source_seq - 1), "第三本左列")
        if 32 <= source_seq <= 61:
            return CropSpec("book3", third_book_row_box(2050, 2920, source_seq - 31), "第三本中列")
        if 62 <= source_seq <= 67:
            return CropSpec("book3", third_book_row_box(2880, 3560, source_seq - 61), "第三本右列")

    return None


def clean_outputs() -> None:
    DIRECTORY_DIR.mkdir(parents=True, exist_ok=True)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    for path in DIRECTORY_DIR.glob("patient_*_directory.jpg"):
        path.unlink()


def load_oriented_sources() -> dict[str, Image.Image]:
    sources: dict[str, Image.Image] = {}
    for key, path in SOURCE_IMAGES.items():
        if not path.exists():
            raise FileNotFoundError(path)
        shutil.copy2(path, SOURCE_DIR / f"{key}{path.suffix.lower()}")
        sources[key] = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return sources


def clamp_box(box: tuple[int, int, int, int], image: Image.Image) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    return (
        max(0, min(image.width, x1)),
        max(0, min(image.height, y1)),
        max(0, min(image.width, x2)),
        max(0, min(image.height, y2)),
    )


def manifest_url(path: Path) -> str:
    relative = path.relative_to(ROOT_DIR / "doc_patient").as_posix()
    return f"/doc_patient/{relative}"


def initials_key(name: str) -> str:
    # Lightweight ordering fallback without external pinyin dependencies.
    return re.sub(r"\s+", "", name)


def build() -> dict[str, Any]:
    clean_outputs()
    sources = load_oriented_sources()
    patients = load_patients()
    items: list[dict[str, Any]] = []

    for patient in patients:
        order = int(patient["import_order"])
        spec = crop_spec_for_patient(patient)
        directory_path: Path | None = None
        has_directory = False
        note = ""

        if spec:
            image = sources[spec.image_key]
            crop = image.crop(clamp_box(spec.box, image))
            directory_path = DIRECTORY_DIR / f"patient_{order:03d}_directory.jpg"
            crop.save(directory_path, quality=92)
            has_directory = True
            note = spec.note
        else:
            note = "未绑定目录签名图"

        items.append(
            {
                "patientId": patient["id"],
                "order": order,
                "name": patient["name"],
                "originalName": patient["original_name"],
                "status": patient["status"],
                "sourceArea": patient["source_area"] or "",
                "sourceSeq": patient["source_seq"] or "",
                "sortKey": initials_key(patient["name"]),
                "directorySignature": manifest_url(directory_path) if directory_path else "",
                "caseSignature": "",
                "visitSignature": "",
                "hasDirectorySignature": has_directory,
                "note": note,
            }
        )

    manifest = {
        "generatedAt": __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(items),
        "directoryCount": sum(1 for item in items if item["hasDirectorySignature"]),
        "items": items,
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    manifest = build()
    print(
        json.dumps(
            {
                "manifest": str(MANIFEST_PATH),
                "count": manifest["count"],
                "directoryCount": manifest["directoryCount"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
