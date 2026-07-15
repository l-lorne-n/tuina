from __future__ import annotations

import sqlite3
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = ROOT / "app"
RELEASE_DIR = APP_ROOT / "TuinaPatientManager"
ZIP_PATH = APP_ROOT / "tuina_windows_with_data_2026-07-11.zip"

REQUIRED_ENTRIES = {
    "TuinaPatientManager/TuinaPatientManager.exe",
    "TuinaPatientManager/data/tuina_records.sqlite3",
    "TuinaPatientManager/doc_patient/signature_patient/manifest.json",
    "TuinaPatientManager/tecent_api_key.txt",
    "TuinaPatientManager/jianguoyun_key.txt",
    "启动推拿系统.bat",
    "使用说明.txt",
}


def database_report(path: Path) -> dict[str, object]:
    with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as conn:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        patient_count = conn.execute("SELECT COUNT(*) FROM patients").fetchone()[0]
        has_migrations = bool(
            conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
            ).fetchone()[0]
        )
    return {
        "integrity": integrity,
        "patientCount": patient_count,
        "hasMigrations": has_migrations,
    }


def main() -> None:
    with zipfile.ZipFile(ZIP_PATH) as package:
        names = set(package.namelist())
        missing = sorted(REQUIRED_ENTRIES - names)
        if missing:
            raise SystemExit(f"missing zip entries: {missing}")
        bad_crc = package.testzip()
        if bad_crc:
            raise SystemExit(f"bad zip CRC: {bad_crc}")
        unicode_entries = [entry for entry in package.infolist() if any(ord(char) > 127 for char in entry.filename)]
        non_utf8_entries = [entry.filename for entry in unicode_entries if not entry.flag_bits & 0x800]
        if non_utf8_entries:
            raise SystemExit(f"unicode zip entries lack UTF-8 flag: {non_utf8_entries[:5]}")
        forbidden = [name for name in names if "/.git/" in name or "__pycache__" in name]
        if forbidden:
            raise SystemExit(f"forbidden development files in zip: {forbidden[:5]}")
        database_sidecars = [name for name in names if name.endswith((".sqlite3-wal", ".sqlite3-shm"))]
        if database_sidecars:
            raise SystemExit(f"SQLite sidecar files must not be shipped: {database_sidecars}")
        launcher = package.read("启动推拿系统.bat").decode("utf-8-sig")
        tools_nav = package.read("TuinaPatientManager/_internal/static/tools-nav.js").decode("utf-8")
        if "http://127.0.0.1:8781/patient-search.html" not in launcher or "--port 8781" not in launcher:
            raise SystemExit("launcher does not open the requested patient-search URL on port 8781")
        if '"/index.html"' not in tools_nav:
            raise SystemExit("packaged toolbar does not link back to the entry page")

    source_doc_count = len(
        [
            path
            for path in (ROOT / "doc_patient").rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and path.suffix.lower() != ".pyc"
        ]
    )
    release_doc_count = len([path for path in (RELEASE_DIR / "doc_patient").rglob("*") if path.is_file()])
    if source_doc_count != release_doc_count:
        raise SystemExit(f"doc_patient file count mismatch: {source_doc_count} != {release_doc_count}")

    source_db = database_report(ROOT / "data" / "tuina_records.sqlite3")
    release_db = database_report(RELEASE_DIR / "data" / "tuina_records.sqlite3")
    if source_db["integrity"] != "ok" or release_db["integrity"] != "ok":
        raise SystemExit("database integrity check failed")
    if source_db["patientCount"] != release_db["patientCount"]:
        raise SystemExit("patient count mismatch")
    if source_db["hasMigrations"]:
        raise SystemExit("source formal database was unexpectedly migrated")
    if not release_db["hasMigrations"]:
        raise SystemExit("release database did not complete first-run migration")

    print({
        "zip": str(ZIP_PATH),
        "zipBytes": ZIP_PATH.stat().st_size,
        "zipEntries": len(names),
        "unicodeEntries": len(unicode_entries),
        "patientFiles": release_doc_count,
        "sourceDatabase": source_db,
        "releaseDatabase": release_db,
    })


if __name__ == "__main__":
    main()
