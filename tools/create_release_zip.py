from __future__ import annotations

import os
import sqlite3
import zipfile
from contextlib import closing
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = PROJECT_ROOT / "app"
RELEASE_DIR = APP_ROOT / "TuinaPatientManager"
LAUNCHER = APP_ROOT / "启动推拿系统.bat"
INSTRUCTIONS = APP_ROOT / "使用说明.txt"
ZIP_PATH = APP_ROOT / "tuina_windows_with_data_2026-07-11.zip"
TEMP_ZIP_PATH = ZIP_PATH.with_suffix(".zip.tmp")
RELEASE_DB = RELEASE_DIR / "data" / "tuina_records.sqlite3"


def checkpoint_release_database() -> None:
    if not RELEASE_DB.exists():
        raise SystemExit(f"missing release database: {RELEASE_DB}")
    with closing(sqlite3.connect(RELEASE_DB, timeout=30)) as conn:
        busy, _, _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if busy:
            raise SystemExit("release database is still in use; stop the packaged app before creating the ZIP")
    for suffix in ("-wal", "-shm"):
        RELEASE_DB.with_name(RELEASE_DB.name + suffix).unlink(missing_ok=True)


def files_to_archive() -> list[tuple[Path, str]]:
    items: list[tuple[Path, str]] = []
    for path in sorted(RELEASE_DIR.rglob("*")):
        if path.is_file():
            arcname = (Path(RELEASE_DIR.name) / path.relative_to(RELEASE_DIR)).as_posix()
            items.append((path, arcname))
    items.append((LAUNCHER, LAUNCHER.name))
    items.append((INSTRUCTIONS, INSTRUCTIONS.name))
    return items


def main() -> None:
    for required in (RELEASE_DIR, LAUNCHER, INSTRUCTIONS):
        if not required.exists():
            raise SystemExit(f"missing release input: {required}")
    checkpoint_release_database()
    TEMP_ZIP_PATH.unlink(missing_ok=True)
    items = files_to_archive()
    try:
        with zipfile.ZipFile(
            TEMP_ZIP_PATH,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
        ) as package:
            for index, (path, arcname) in enumerate(items, start=1):
                package.write(path, arcname)
                if index % 1000 == 0:
                    print(f"archived {index}/{len(items)}", flush=True)
        with zipfile.ZipFile(TEMP_ZIP_PATH) as package:
            bad_file = package.testzip()
            if bad_file:
                raise RuntimeError(f"zip CRC check failed: {bad_file}")
        os.replace(TEMP_ZIP_PATH, ZIP_PATH)
    except Exception:
        TEMP_ZIP_PATH.unlink(missing_ok=True)
        raise
    print(f"zip={ZIP_PATH}")
    print(f"files={len(items)}")
    print(f"bytes={ZIP_PATH.stat().st_size}")


if __name__ == "__main__":
    main()
