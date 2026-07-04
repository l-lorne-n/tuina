from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import socketserver
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / "data"
DB_PATH = DATA_DIR / "tuina_records.sqlite3"
EXCEL_DIR = APP_DIR / "doc_patient"
SIGNATURE_PATIENT_DIR = APP_DIR / "doc_patient" / "signature_patient"
SIGNATURE_MANIFEST_PATH = SIGNATURE_PATIENT_DIR / "manifest.json"
SIGNATURE_BINDINGS_PATH = SIGNATURE_PATIENT_DIR / "bindings.json"
ELECTRONIC_SIGNATURE_DIR = SIGNATURE_PATIENT_DIR / "electronic"
TEST_SIGNATURE_DIR = SIGNATURE_PATIENT_DIR / "electronic_test"

TENCENT_ENDPOINT = "https://asr.tencentcloudapi.com"
TENCENT_HOST = "asr.tencentcloudapi.com"
TENCENT_SERVICE = "asr"
TENCENT_ACTION = "SentenceRecognition"
TENCENT_VERSION = "2019-06-14"

MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_AUDIO_BYTES = 5 * 1024 * 1024
MAX_AUDIO_SECONDS = 60.5
MAX_SIGNATURE_IMAGE_BYTES = 5 * 1024 * 1024
DEFAULT_SESSION_PRICE = 90

NUMBER_TOKEN = r"[0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千万幺点]+"
NUM = f"(?:{NUMBER_TOKEN})"
LABEL_SEP = r"[\s,，.。;；:：、]*"
DATE_FRAGMENT = (
    fr"(?:{NUM}年{NUM}月{NUM}(?:日|号)?"
    fr"|[0-9]{{5,6}}月[0-9]{{1,2}}(?:日|号)?"
    fr"|{NUM}月{NUM}(?:日|号)?)"
)
CN_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "幺": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}


def load_dotenv() -> None:
    for env_path in (APP_DIR / ".env",):
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def load_tencent_key_file() -> None:
    for key_path in (
        APP_DIR / "tecent_api_key.txt",
        APP_DIR / "tencent_api_key.txt",
    ):
        if not key_path.exists():
            continue

        parsed: dict[str, str] = {}
        for raw_line in key_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                key, value = line.split(":", 1)
            elif "=" in line:
                key, value = line.split("=", 1)
            else:
                continue
            parsed[key.strip().lower()] = value.strip().strip('"').strip("'")

        if parsed.get("secretid") and "TENCENT_SECRET_ID" not in os.environ:
            os.environ["TENCENT_SECRET_ID"] = parsed["secretid"]
        if parsed.get("secretkey") and "TENCENT_SECRET_KEY" not in os.environ:
            os.environ["TENCENT_SECRET_KEY"] = parsed["secretkey"]
        return


def json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def read_json_body(handler: SimpleHTTPRequestHandler, max_bytes: int = MAX_JSON_BYTES) -> dict[str, Any]:
    content_length = int(handler.headers.get("Content-Length", "0"))
    if content_length <= 0 or content_length > max_bytes:
        raise ValueError("请求体为空或过大。")
    body = handler.rfile.read(content_length)
    parsed = json.loads(body.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("请求体必须是 JSON 对象。")
    return parsed


def now_text() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS patients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                import_order INTEGER NOT NULL,
                source_area TEXT,
                source_seq TEXT,
                original_name TEXT NOT NULL,
                name TEXT NOT NULL,
                gender TEXT,
                age TEXT,
                weight TEXT,
                height TEXT,
                address TEXT,
                phone TEXT,
                remaining_sessions INTEGER,
                raw_transcript TEXT,
                notes TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS recharges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                recharge_date TEXT,
                amount INTEGER,
                sessions INTEGER,
                raw_text TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_adjustments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                operation TEXT NOT NULL,
                sessions INTEGER NOT NULL,
                amount REAL,
                before_sessions INTEGER,
                after_sessions INTEGER NOT NULL,
                occurred_at TEXT NOT NULL,
                note TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
            )
            """
        )
        ensure_session_adjustment_columns(conn)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_patients_order ON patients(import_order)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_patients_status ON patients(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_recharges_patient ON recharges(patient_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_session_adjustments_patient ON session_adjustments(patient_id)")
        seed_patients_from_excel(conn)
        conn.commit()


def seed_patients_from_excel(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT COUNT(*) AS count FROM patients").fetchone()
    if row and row["count"]:
        return

    excel_files = [
        path
        for path in sorted(EXCEL_DIR.glob("*.xlsx"))
        if not path.name.startswith("~$")
    ]
    if not excel_files:
        return

    try:
        import openpyxl
    except ImportError as exc:
        raise RuntimeError("缺少 openpyxl，无法导入人名 Excel。请先运行：python -m pip install openpyxl") from exc

    workbook = openpyxl.load_workbook(excel_files[0])
    sheet = workbook[workbook.sheetnames[0]]
    created_at = now_text()
    import_order = 1
    for row_cells in sheet.iter_rows(min_row=4, values_only=False):
        area = clean_cell(row_cells[0].value)
        seq = clean_cell(row_cells[1].value)
        name = clean_cell(row_cells[2].value)
        note = clean_cell(row_cells[3].value)
        name_struck = bool(getattr(row_cells[2].font, "strike", False))
        note_struck = bool(getattr(row_cells[3].font, "strike", False))

        if not name:
            continue
        if name_struck or note_struck or "划掉" in note or "删除" in note:
            continue

        conn.execute(
            """
            INSERT INTO patients (
                import_order, source_area, source_seq, original_name, name,
                status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (import_order, area, seq, name, name, created_at, created_at),
        )
        import_order += 1


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def ensure_session_adjustment_columns(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(session_adjustments)").fetchall()
    }
    if "amount" not in columns:
        conn.execute("ALTER TABLE session_adjustments ADD COLUMN amount REAL")


def row_to_patient_summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "order": row["import_order"],
        "originalName": row["original_name"],
        "name": row["name"],
        "gender": row["gender"] or "",
        "age": row["age"] or "",
        "phone": row["phone"] or "",
        "remainingSessions": row["remaining_sessions"],
        "status": row["status"],
        "rechargeCount": row["recharge_count"] or 0,
        "updatedAt": row["updated_at"],
    }


def list_patients() -> list[dict[str, Any]]:
    with connect_db() as conn:
        rows = conn.execute(
            """
            SELECT p.*, COUNT(r.id) AS recharge_count
            FROM patients p
            LEFT JOIN recharges r ON r.patient_id = p.id
            GROUP BY p.id
            ORDER BY p.import_order ASC, p.id ASC
            """
        ).fetchall()
    return [row_to_patient_summary(row) for row in rows]


def create_patient(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    name = str(payload.get("name") or "新建卡片").strip() or "新建卡片"
    created_at = now_text()
    with connect_db() as conn:
        next_order = conn.execute(
            "SELECT COALESCE(MAX(import_order), 0) + 1 AS next_order FROM patients"
        ).fetchone()["next_order"]
        cursor = conn.execute(
            """
            INSERT INTO patients (
                import_order, source_area, source_seq, original_name, name,
                status, created_at, updated_at
            )
            VALUES (?, ?, '', ?, ?, 'pending', ?, ?)
            """,
            (next_order, "手动新增", name, name, created_at, created_at),
        )
        conn.commit()
        patient_id = int(cursor.lastrowid)

    patient = get_patient(patient_id)
    if not patient:
        raise ValueError("新建卡片后读取失败。")
    return patient


def get_patient(patient_id: int) -> dict[str, Any] | None:
    with connect_db() as conn:
        patient = conn.execute("SELECT * FROM patients WHERE id = ?", (patient_id,)).fetchone()
        if not patient:
            return None
        recharges = conn.execute(
            """
            SELECT recharge_date, amount, sessions, raw_text
            FROM recharges
            WHERE patient_id = ?
            ORDER BY position ASC, id ASC
            """,
            (patient_id,),
        ).fetchall()

    return {
        "id": patient["id"],
        "order": patient["import_order"],
        "sourceArea": patient["source_area"] or "",
        "sourceSeq": patient["source_seq"] or "",
        "originalName": patient["original_name"],
        "name": patient["name"],
        "gender": patient["gender"] or "",
        "age": patient["age"] or "",
        "weight": patient["weight"] or "",
        "height": patient["height"] or "",
        "address": patient["address"] or "",
        "phone": patient["phone"] or "",
        "remainingSessions": patient["remaining_sessions"],
        "rawTranscript": patient["raw_transcript"] or "",
        "notes": patient["notes"] or "",
        "status": patient["status"],
        "createdAt": patient["created_at"],
        "updatedAt": patient["updated_at"],
        "recharges": [
            {
                "date": row["recharge_date"] or "",
                "amount": row["amount"],
                "sessions": row["sessions"],
                "rawText": row["raw_text"] or "",
            }
            for row in recharges
        ],
    }


def save_patient(patient_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    current = get_patient(patient_id)
    if not current:
        raise ValueError("没有找到这个人名。")

    status = str(payload.get("status") or "pending").strip()
    if status not in {"pending", "completed", "review"}:
        status = "pending"

    remaining = payload.get("remainingSessions")
    remaining_sessions = None
    if remaining not in (None, ""):
        remaining_sessions = int(remaining)

    updated_at = now_text()
    with connect_db() as conn:
        conn.execute(
            """
            UPDATE patients
            SET name = ?, gender = ?, age = ?, weight = ?, height = ?, address = ?,
                phone = ?, remaining_sessions = ?, raw_transcript = ?, notes = ?,
                status = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                str(payload.get("name") or current["name"]).strip(),
                str(payload.get("gender") or "").strip(),
                str(payload.get("age") or "").strip(),
                str(payload.get("weight") or "").strip(),
                str(payload.get("height") or "").strip(),
                str(payload.get("address") or "").strip(),
                str(payload.get("phone") or "").strip(),
                remaining_sessions,
                str(payload.get("rawTranscript") or "").strip(),
                str(payload.get("notes") or "").strip(),
                status,
                updated_at,
                patient_id,
            ),
        )
        conn.execute("DELETE FROM recharges WHERE patient_id = ?", (patient_id,))
        for index, recharge in enumerate(payload.get("recharges") or [], start=1):
            if not isinstance(recharge, dict):
                continue
            amount = optional_int(recharge.get("amount"))
            sessions = optional_int(recharge.get("sessions"))
            recharge_date = str(recharge.get("date") or "").strip()
            raw_text = str(recharge.get("rawText") or "").strip()
            if not (recharge_date or amount is not None or sessions is not None or raw_text):
                continue
            conn.execute(
                """
                INSERT INTO recharges (
                    patient_id, position, recharge_date, amount, sessions, raw_text, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (patient_id, index, recharge_date, amount, sessions, raw_text, updated_at),
            )
        conn.commit()

    saved = get_patient(patient_id)
    if not saved:
        raise ValueError("保存后读取失败。")
    return saved


def row_to_session_adjustment(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "patientId": row["patient_id"],
        "operation": row["operation"],
        "sessions": row["sessions"],
        "amount": row["amount"],
        "beforeSessions": row["before_sessions"],
        "afterSessions": row["after_sessions"],
        "occurredAt": row["occurred_at"],
        "note": row["note"] or "",
        "createdAt": row["created_at"],
    }


def list_session_adjustments(patient_id: int) -> list[dict[str, Any]]:
    with connect_db() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM session_adjustments
            WHERE patient_id = ?
            ORDER BY occurred_at DESC, id DESC
            """,
            (patient_id,),
        ).fetchall()
    return [row_to_session_adjustment(row) for row in rows]


def get_signature_item(patient_id: int) -> dict[str, Any]:
    if not SIGNATURE_MANIFEST_PATH.exists():
        return {}
    manifest = load_signature_manifest()
    for item in manifest.get("items") or []:
        if int(item.get("patientId") or 0) == patient_id:
            return item
    return {}


def get_visit_signature_history(patient_id: int) -> list[dict[str, Any]]:
    try:
        bindings = load_signature_bindings()
    except Exception:
        return []
    patient_binding = (bindings.get("patients") or {}).get(str(patient_id))
    if not isinstance(patient_binding, dict):
        return []
    history = patient_binding.get("history")
    if not isinstance(history, list):
        return []

    items: list[dict[str, Any]] = []
    for entry in history:
        if not isinstance(entry, dict):
            continue
        if entry.get("kind") != "visit" and entry.get("field") != "visitSignature":
            continue
        url = str(entry.get("url") or "").strip()
        if not url:
            continue
        items.append(
            {
                "url": url,
                "savedAt": str(entry.get("savedAt") or "").strip(),
                "signerName": str(entry.get("signerName") or "").strip(),
                "note": str(entry.get("note") or "").strip(),
            }
        )
    return items


def get_session_page(patient_id: int) -> dict[str, Any]:
    patient = get_patient(patient_id)
    if not patient:
        raise ValueError("patient not found")
    return {
        "patient": patient,
        "signature": get_signature_item(patient_id),
        "visitSignatures": get_visit_signature_history(patient_id),
        "adjustments": list_session_adjustments(patient_id),
    }


def apply_session_adjustment(patient_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    operation = str(payload.get("operation") or "").strip()
    if operation not in {"increase", "decrease"}:
        raise ValueError("operation must be increase or decrease")
    sessions = optional_int(payload.get("sessions"))
    if sessions is None or sessions <= 0:
        raise ValueError("sessions must be a positive integer")
    amount = optional_float(payload.get("amount")) if operation == "increase" else None
    if operation == "increase":
        if amount is None:
            amount = float(sessions * DEFAULT_SESSION_PRICE)
        if amount < 0:
            raise ValueError("充值金额不能小于 0")

    occurred_at = str(payload.get("occurredAt") or "").strip() or now_text()
    note = str(payload.get("note") or "").strip()
    created_at = now_text()

    with connect_db() as conn:
        patient = conn.execute(
            "SELECT id, remaining_sessions FROM patients WHERE id = ?",
            (patient_id,),
        ).fetchone()
        if not patient:
            raise ValueError("patient not found")

        before_sessions = patient["remaining_sessions"]
        before_value = int(before_sessions) if before_sessions is not None else 0
        if operation == "increase":
            after_sessions = before_value + sessions
        else:
            if sessions > before_value:
                raise ValueError("剩余次数不足，不能减少这么多")
            after_sessions = before_value - sessions

        conn.execute(
            """
            UPDATE patients
            SET remaining_sessions = ?, updated_at = ?
            WHERE id = ?
            """,
            (after_sessions, created_at, patient_id),
        )
        cursor = conn.execute(
            """
            INSERT INTO session_adjustments (
                patient_id, operation, sessions, amount, before_sessions, after_sessions,
                occurred_at, note, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                patient_id,
                operation,
                sessions,
                amount,
                before_sessions,
                after_sessions,
                occurred_at,
                note,
                created_at,
            ),
        )
        conn.commit()
        adjustment_id = int(cursor.lastrowid)

    return {
        "adjustment": {
            "id": adjustment_id,
            "patientId": patient_id,
            "operation": operation,
            "sessions": sessions,
            "amount": amount,
            "beforeSessions": before_sessions,
            "afterSessions": after_sessions,
            "occurredAt": occurred_at,
            "note": note,
            "createdAt": created_at,
        },
        "patient": get_patient(patient_id),
        "adjustments": list_session_adjustments(patient_id),
    }


def optional_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(str(value).strip()))
    except ValueError:
        return None


def optional_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).strip())
    except ValueError as exc:
        raise ValueError(f"invalid number: {value}") from exc


def export_csv() -> bytes:
    patients = list_patients()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "顺序",
            "原姓名",
            "当前姓名",
            "性别",
            "年龄",
            "电话",
            "体重",
            "身高",
            "地址",
            "充值记录",
            "剩余次数",
            "状态",
            "备注",
            "识别原文",
            "更新时间",
        ]
    )
    for summary in patients:
        patient = get_patient(int(summary["id"]))
        if not patient:
            continue
        recharge_text = "；".join(
            [
                f"{item.get('date') or '未填日期'} {item.get('amount') or ''}元 {item.get('sessions') or ''}次".strip()
                for item in patient["recharges"]
            ]
        )
        writer.writerow(
            [
                patient["order"],
                patient["originalName"],
                patient["name"],
                patient["gender"],
                patient["age"],
                patient["phone"],
                patient["weight"],
                patient["height"],
                patient["address"],
                recharge_text,
                patient["remainingSessions"] if patient["remainingSessions"] is not None else "",
                patient["status"],
                patient["notes"],
                patient["rawTranscript"],
                patient["updatedAt"],
            ]
        )
    return ("\ufeff" + output.getvalue()).encode("utf-8-sig")


def public_config() -> dict[str, str]:
    return {
        "engine": get_env("TENCENT_ASR_ENGINE", default="16k_zh_medical"),
        "region": tencent_region(),
        "transport": "http",
        "hasCredentials": str(bool(tencent_secret_id() and tencent_secret_key())).lower(),
        "hotwordId": "configured" if os.getenv("TENCENT_ASR_HOTWORD_ID") else "",
    }


def get_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


def tencent_secret_id() -> str:
    return get_env("TENCENT_SECRET_ID", "TENCENTCLOUD_SECRET_ID")


def tencent_secret_key() -> str:
    return get_env("TENCENT_SECRET_KEY", "TENCENTCLOUD_SECRET_KEY")


def tencent_token() -> str:
    return get_env("TENCENT_TOKEN", "TENCENTCLOUD_TOKEN")


def tencent_region() -> str:
    return get_env("TENCENT_REGION", "TENCENTCLOUD_REGION", default="ap-guangzhou")


def hmac_sha256(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def sha256_hex(message: bytes | str) -> str:
    if isinstance(message, str):
        message = message.encode("utf-8")
    return hashlib.sha256(message).hexdigest()


def build_tencent_headers(payload: bytes) -> dict[str, str]:
    secret_id = tencent_secret_id()
    secret_key = tencent_secret_key()
    if not secret_id or not secret_key:
        raise RuntimeError("缺少腾讯云密钥，请检查 tecent_api_key.txt。")

    timestamp = int(time.time())
    date = dt.datetime.utcfromtimestamp(timestamp).strftime("%Y-%m-%d")
    canonical_headers = (
        "content-type:application/json; charset=utf-8\n"
        f"host:{TENCENT_HOST}\n"
        f"x-tc-action:{TENCENT_ACTION.lower()}\n"
    )
    signed_headers = "content-type;host;x-tc-action"
    canonical_request = "\n".join(
        ["POST", "/", "", canonical_headers, signed_headers, sha256_hex(payload)]
    )
    credential_scope = f"{date}/{TENCENT_SERVICE}/tc3_request"
    string_to_sign = "\n".join(
        ["TC3-HMAC-SHA256", str(timestamp), credential_scope, sha256_hex(canonical_request)]
    )

    secret_date = hmac_sha256(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = hmac_sha256(secret_date, TENCENT_SERVICE)
    secret_signing = hmac_sha256(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    authorization = (
        "TC3-HMAC-SHA256 "
        f"Credential={secret_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )

    headers = {
        "Authorization": authorization,
        "Content-Type": "application/json; charset=utf-8",
        "Host": TENCENT_HOST,
        "X-TC-Action": TENCENT_ACTION,
        "X-TC-Timestamp": str(timestamp),
        "X-TC-Version": TENCENT_VERSION,
        "X-TC-Region": tencent_region(),
    }
    token = tencent_token()
    if token:
        headers["X-TC-Token"] = token
    return headers


def wav_duration_seconds(audio_bytes: bytes) -> float:
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        frames = wav_file.getnframes()
        frame_rate = wav_file.getframerate()
        if frame_rate <= 0:
            raise ValueError("WAV 采样率无效。")
        return frames / frame_rate


def build_sentence_request_payload(audio_bytes: bytes) -> dict[str, Any]:
    request_payload: dict[str, Any] = {
        "ProjectId": 0,
        "SubServiceType": 2,
        "EngSerViceType": get_env("TENCENT_ASR_ENGINE", default="16k_zh_medical"),
        "SourceType": 1,
        "VoiceFormat": "wav",
        "UsrAudioKey": uuid.uuid4().hex,
        "Data": base64.b64encode(audio_bytes).decode("ascii"),
        "DataLen": len(audio_bytes),
        "FilterDirty": 0,
        "FilterModal": 0,
        "FilterPunc": int(os.getenv("TENCENT_ASR_FILTER_PUNC", "0")),
        "ConvertNumMode": 1,
        "WordInfo": 0,
    }
    hotword_id = os.getenv("TENCENT_ASR_HOTWORD_ID")
    if hotword_id:
        request_payload["HotwordId"] = hotword_id
    return request_payload


def call_tencent_http(request_payload: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps(request_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        TENCENT_ENDPOINT,
        data=payload,
        headers=build_tencent_headers(payload),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_body = response.read()
    except urllib.error.HTTPError as exc:
        response_body = exc.read()
        raise RuntimeError(parse_tencent_error(response_body) or f"腾讯云接口返回 HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接腾讯云接口：{exc.reason}") from exc
    return json.loads(response_body.decode("utf-8"))


def parse_sentence_response(parsed: dict[str, Any]) -> dict[str, Any]:
    response_data = parsed.get("Response", parsed)
    if "Error" in response_data:
        error = response_data["Error"]
        message = error.get("Message") or "腾讯云识别失败。"
        code = error.get("Code")
        raise RuntimeError(f"{code}: {message}" if code else message)
    return response_data


def transcribe_audio(audio_bytes: bytes) -> dict[str, Any]:
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise ValueError("音频文件过大，请录制 60 秒以内的短音频。")
    duration = wav_duration_seconds(audio_bytes)
    if duration > MAX_AUDIO_SECONDS:
        raise ValueError("音频超过 60 秒，请重录。")

    request_payload = build_sentence_request_payload(audio_bytes)
    started = time.perf_counter()
    parsed = call_tencent_http(request_payload)
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    response_data = parse_sentence_response(parsed)
    return {
        "text": response_data.get("Result", ""),
        "audioDuration": response_data.get("AudioDuration", duration),
        "latencyMs": elapsed_ms,
        "requestId": response_data.get("RequestId", ""),
        "engine": request_payload["EngSerViceType"],
        "transport": "http",
        "audioBytes": len(audio_bytes),
    }


def parse_tencent_error(response_body: bytes) -> str:
    try:
        parsed = json.loads(response_body.decode("utf-8"))
        error = parsed.get("Response", {}).get("Error", {})
        code = error.get("Code")
        message = error.get("Message")
        if code and message:
            return f"{code}: {message}"
        return message or code or ""
    except Exception:
        return response_body.decode("utf-8", errors="replace")[:500]


def parse_record_text(text: str) -> dict[str, Any]:
    normalized = normalize_text(text)
    fields: dict[str, Any] = {
        "gender": extract_gender(normalized),
        "age": extract_number_field(normalized, "年龄", ("岁", "个月", "月")),
        "weight": extract_number_field(normalized, "体重", ("斤", "公斤", "千克", "kg", "KG")),
        "height": extract_number_field(normalized, "身高", ("厘米", "公分", "cm", "CM")),
        "address": extract_text_between(normalized, "地址", ("联系电话", "电话", "手机", "身高", "金额", "剩余", "还剩")),
        "phone": extract_phone(normalized),
        "remainingSessions": extract_remaining(normalized),
    }
    recharges = extract_recharges(normalized)
    return {"fields": fields, "recharges": recharges}


def normalize_text(text: str) -> str:
    table = str.maketrans(
        "０１２３４５６７８９：，。；（）－",
        "0123456789:,.;()-",
    )
    return re.sub(r"\s+", "", text.translate(table).strip())


def extract_gender(text: str) -> str:
    match = re.search(fr"性别{LABEL_SEP}([男女])", text)
    return match.group(1) if match else ""


def extract_number_field(text: str, label: str, units: tuple[str, ...]) -> str:
    unit_pattern = "|".join(re.escape(unit) for unit in units)
    match = re.search(fr"{label}{LABEL_SEP}({NUMBER_TOKEN})(?:{unit_pattern})?", text, re.IGNORECASE)
    if not match:
        return ""
    value = number_token_to_float(match.group(1))
    if value is None:
        return match.group(1)
    if float(value).is_integer():
        return str(int(value))
    return str(value)


def extract_text_between(text: str, label: str, stop_labels: tuple[str, ...]) -> str:
    stop_pattern = "|".join(re.escape(stop) for stop in stop_labels)
    match = re.search(fr"{label}{LABEL_SEP}(.*?)(?={stop_pattern}|$)", text)
    return match.group(1).strip("，,。.;；") if match else ""


def extract_phone(text: str) -> str:
    match = re.search(fr"(?:联系电话|电话|手机){LABEL_SEP}([0-9零〇一二两三四五六七八九幺\-\s]{{6,22}})", text)
    if not match:
        return ""
    raw = match.group(1)
    digits: list[str] = []
    for char in raw:
        if char.isdigit():
            digits.append(char)
        elif char in CN_DIGITS:
            digits.append(str(CN_DIGITS[char]))
    return "".join(digits)


def extract_remaining(text: str) -> int | None:
    match = re.search(
        fr"(?:目前)?(?:剩余次数|剩余|还剩|剩){LABEL_SEP}(?:为|是|还有|有)?{LABEL_SEP}({NUMBER_TOKEN}){LABEL_SEP}次",
        text,
    )
    if not match:
        return None
    value = number_token_to_int(match.group(1))
    return value


def extract_recharges(text: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    scan_recharge_pairs(text, items)

    for match in re.finditer(fr"(?:金额|充值|充){LABEL_SEP}(.*?)(?=金额|充值|充|剩余|还剩|$)", text):
        chunk = match.group(1).strip("，,。.;；")
        if not chunk:
            continue
        if scan_recharge_pairs(chunk, items):
            continue
        amount = extract_amount(chunk)
        date_text = extract_date(chunk)
        add_recharge_item(items, date_text, amount, chunk)
    return items


def scan_recharge_pairs(text: str, items: list[dict[str, Any]]) -> int:
    date_pattern = re.compile(DATE_FRAGMENT)
    amount_pattern = re.compile(fr"({NUM})(?:元|块|块钱)")
    date_matches = list(date_pattern.finditer(text))
    count = 0
    for index, date_match in enumerate(date_matches):
        next_start = date_matches[index + 1].start() if index + 1 < len(date_matches) else len(text)
        segment = text[date_match.start() : next_start]
        amount_match = amount_pattern.search(segment)
        if not amount_match:
            continue
        chunk = segment[: amount_match.end()].strip("，,。.;；")
        date_text = extract_date(date_match.group(0))
        amount = number_token_to_int(amount_match.group(1))
        add_recharge_item(items, date_text, amount, chunk)
        count += 1
    return count


def add_recharge_item(
    items: list[dict[str, Any]],
    date_text: str,
    amount: int | None,
    raw_text: str,
) -> None:
    if amount is None and not date_text:
        return
    if any(item.get("rawText") == raw_text for item in items):
        return
    if any(item.get("date") == date_text and item.get("amount") == amount for item in items):
        return
    items.append(
        {
            "date": date_text,
            "amount": amount,
            "sessions": infer_sessions(amount),
            "rawText": raw_text,
        }
    )


def extract_amount(text: str) -> int | None:
    match = re.search(fr"({NUMBER_TOKEN})(?:元|块|块钱)", text)
    if not match:
        all_numbers = re.findall(NUMBER_TOKEN, text)
        if not all_numbers:
            return None
        match_text = all_numbers[-1]
    else:
        match_text = match.group(1)
    return number_token_to_int(match_text)


def extract_date(text: str) -> str:
    year_match = re.search(fr"({NUMBER_TOKEN})年({NUMBER_TOKEN})月({NUMBER_TOKEN})(?:日|号)?", text)
    if year_match:
        return format_date_parts(year_match.group(1), year_match.group(2), year_match.group(3))

    compact_year_match = re.search(r"([0-9]{4})([0-9]{1,2})月([0-9]{1,2})(?:日|号)?", text)
    if compact_year_match:
        return format_date_parts(
            compact_year_match.group(1),
            compact_year_match.group(2),
            compact_year_match.group(3),
        )

    month_match = re.search(fr"({NUMBER_TOKEN})月({NUMBER_TOKEN})(?:日|号)?", text)
    if month_match:
        month = number_token_to_int(month_match.group(1))
        day = number_token_to_int(month_match.group(2))
        if month is not None and day is not None and is_valid_month_day(month, day):
            return f"{month:02d}-{day:02d}"
    return ""


def format_date_parts(year_text: str, month_text: str, day_text: str) -> str:
    year = number_token_to_int(year_text)
    month = number_token_to_int(month_text)
    day = number_token_to_int(day_text)
    if year is None or month is None or day is None:
        return ""
    if year < 100:
        year += 2000
    if not is_valid_month_day(month, day):
        return ""
    return f"{year:04d}-{month:02d}-{day:02d}"


def is_valid_month_day(month: int, day: int) -> bool:
    return 1 <= month <= 12 and 1 <= day <= 31


def infer_sessions(amount: int | None) -> int | None:
    if amount is None:
        return None
    if amount % 90 == 0:
        return amount // 90
    if amount == 900:
        return 10
    return None


def number_token_to_float(token: str) -> float | None:
    token = token.strip()
    if not token:
        return None
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", token):
        return float(token)
    if "点" in token:
        integer, fraction = token.split("点", 1)
        int_value = number_token_to_int(integer) if integer else 0
        if int_value is None:
            return None
        fraction_digits = "".join(str(CN_DIGITS.get(char, "")) for char in fraction)
        if not fraction_digits:
            return float(int_value)
        return float(f"{int_value}.{fraction_digits}")
    int_value = number_token_to_int(token)
    return float(int_value) if int_value is not None else None


def number_token_to_int(token: str) -> int | None:
    token = token.strip()
    if not token:
        return None
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", token):
        return int(float(token))
    if all(char in CN_DIGITS for char in token):
        return int("".join(str(CN_DIGITS[char]) for char in token))

    total = 0
    section = 0
    number = 0
    for char in token:
        if char in CN_DIGITS:
            number = CN_DIGITS[char]
            continue
        unit = CN_UNITS.get(char)
        if not unit:
            continue
        if unit == 10000:
            section = (section + number) * unit
            total += section
            section = 0
        else:
            section += (number or 1) * unit
        number = 0
    return total + section + number


SIGNATURE_KIND_TO_FIELD = {
    "directory": "directorySignature",
    "case": "caseSignature",
    "visit": "visitSignature",
}


def load_signature_manifest() -> dict[str, Any]:
    manifest = json.loads(SIGNATURE_MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("signature manifest is invalid")
    return apply_signature_bindings(manifest)


def load_signature_bindings() -> dict[str, Any]:
    if not SIGNATURE_BINDINGS_PATH.exists():
        return {"updatedAt": "", "patients": {}}
    parsed = json.loads(SIGNATURE_BINDINGS_PATH.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        return {"updatedAt": "", "patients": {}}
    patients = parsed.get("patients")
    if not isinstance(patients, dict):
        parsed["patients"] = {}
    return parsed


def save_signature_bindings(bindings: dict[str, Any]) -> None:
    SIGNATURE_PATIENT_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = SIGNATURE_BINDINGS_PATH.with_suffix(".tmp")
    temp_path.write_text(
        json.dumps(bindings, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temp_path.replace(SIGNATURE_BINDINGS_PATH)


def apply_signature_bindings(manifest: dict[str, Any]) -> dict[str, Any]:
    try:
        bindings = load_signature_bindings()
    except Exception:
        bindings = {"updatedAt": "", "patients": {}}
    bound_patients = bindings.get("patients") or {}
    if not isinstance(bound_patients, dict):
        bound_patients = {}

    for item in manifest.get("items") or []:
        if not isinstance(item, dict):
            continue
        patient_binding = bound_patients.get(str(item.get("patientId")))
        if not isinstance(patient_binding, dict):
            item["hasDirectorySignature"] = bool(item.get("directorySignature"))
            continue
        for field in SIGNATURE_KIND_TO_FIELD.values():
            url = patient_binding.get(field)
            if isinstance(url, str) and url:
                item[field] = url
        item["hasDirectorySignature"] = bool(item.get("directorySignature"))
        if patient_binding.get("updatedAt"):
            item["electronicSignatureUpdatedAt"] = patient_binding["updatedAt"]

    if bindings.get("updatedAt"):
        manifest["bindingUpdatedAt"] = bindings["updatedAt"]
    return manifest


def signature_public_url(path: Path) -> str:
    root = SIGNATURE_PATIENT_DIR.resolve()
    resolved = path.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("signature path escaped storage directory")
    relative = resolved.relative_to(root)
    return "/doc_patient/signature_patient/" + relative.as_posix()


def decode_signature_png(payload: dict[str, Any]) -> bytes:
    image_data = str(payload.get("imageData") or "")
    if "," in image_data:
        header, image_base64 = image_data.split(",", 1)
        if "image/png" not in header:
            raise ValueError("only png signatures are supported")
    else:
        image_base64 = image_data
    if not image_base64:
        raise ValueError("missing signature image")

    image_bytes = base64.b64decode(image_base64, validate=True)
    if len(image_bytes) > MAX_SIGNATURE_IMAGE_BYTES:
        raise ValueError("signature image is too large")
    if not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("signature image must be a png")
    return image_bytes


def save_electronic_signature(payload: dict[str, Any]) -> dict[str, Any]:
    patient_id = int(payload.get("patientId") or 0)
    patient = get_patient(patient_id)
    if not patient:
        raise ValueError("patient not found")

    kind = str(payload.get("kind") or "visit").strip()
    field = SIGNATURE_KIND_TO_FIELD.get(kind)
    if not field:
        raise ValueError("signature kind must be directory, case, or visit")

    image_bytes = decode_signature_png(payload)
    saved_at = now_text()
    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    order = int(patient.get("order") or patient_id)
    target_dir = ELECTRONIC_SIGNATURE_DIR / kind
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"patient_{order:03d}_{kind}_{timestamp}.png"
    target_path.write_bytes(image_bytes)
    url = signature_public_url(target_path)

    bindings = load_signature_bindings()
    bindings["updatedAt"] = saved_at
    bound_patients = bindings.setdefault("patients", {})
    patient_binding = bound_patients.setdefault(str(patient_id), {})
    patient_binding[field] = url
    patient_binding["updatedAt"] = saved_at

    history = patient_binding.setdefault("history", [])
    if not isinstance(history, list):
        history = []
        patient_binding["history"] = history
    history.append(
        {
            "kind": kind,
            "field": field,
            "url": url,
            "signerName": str(payload.get("signerName") or "").strip(),
            "note": str(payload.get("note") or "").strip(),
            "savedAt": saved_at,
        }
    )
    del history[:-50]
    save_signature_bindings(bindings)

    return {
        "patientId": patient_id,
        "kind": kind,
        "field": field,
        "url": url,
        "filePath": str(target_path),
        "savedAt": saved_at,
    }


def save_test_signature(payload: dict[str, Any]) -> dict[str, Any]:
    kind = str(payload.get("kind") or "visit").strip()
    if kind not in SIGNATURE_KIND_TO_FIELD:
        raise ValueError("signature kind must be directory, case, or visit")

    image_bytes = decode_signature_png(payload)
    saved_at = now_text()
    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    target_dir = TEST_SIGNATURE_DIR / kind
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"test_{kind}_{timestamp}.png"
    target_path.write_bytes(image_bytes)
    url = signature_public_url(target_path)
    return {
        "kind": kind,
        "url": url,
        "filePath": str(target_path),
        "savedAt": saved_at,
        "signerName": str(payload.get("signerName") or "").strip(),
        "note": str(payload.get("note") or "").strip(),
    }


def list_test_signatures(limit: int = 20) -> list[dict[str, Any]]:
    if not TEST_SIGNATURE_DIR.exists():
        return []
    files = sorted(
        TEST_SIGNATURE_DIR.glob("*/*.png"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    items: list[dict[str, Any]] = []
    for path in files[:limit]:
        modified_at = dt.datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        items.append(
            {
                "kind": path.parent.name,
                "url": signature_public_url(path),
                "filePath": str(path),
                "savedAt": modified_at,
            }
        )
    return items


class TuinaHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        clean_path = urllib.parse.urlparse(path).path
        if clean_path in ("/", "/index.html"):
            return str(STATIC_DIR / "index.html")
        if clean_path in ("/patient-search", "/patient-search.html"):
            return str(STATIC_DIR / "patient-search.html")
        if clean_path in ("/patient-sessions", "/patient-sessions.html"):
            return str(STATIC_DIR / "patient-sessions.html")
        if clean_path in ("/signature-browser", "/signature-browser.html"):
            return str(STATIC_DIR / "signature-browser.html")
        if clean_path in ("/signature-review", "/signature-review.html"):
            return str(STATIC_DIR / "signature-review.html")
        if clean_path in ("/signature-pad", "/signature-pad.html"):
            return str(STATIC_DIR / "signature-pad.html")
        if clean_path in ("/signature-test", "/signature-test.html"):
            return str(STATIC_DIR / "signature-test.html")
        if clean_path.startswith("/doc_patient/signature_patient/"):
            relative = urllib.parse.unquote(clean_path.removeprefix("/doc_patient/signature_patient/"))
            candidate = (SIGNATURE_PATIENT_DIR / relative).resolve()
            root = SIGNATURE_PATIENT_DIR.resolve()
            if candidate == root or root in candidate.parents:
                return str(candidate)
            return str(STATIC_DIR / "__not_found__")
        return str(STATIC_DIR / clean_path.lstrip("/"))

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == "/api/config":
            json_response(self, HTTPStatus.OK, {"ok": True, "config": public_config()})
            return
        if parsed_path.path == "/api/signature-manifest":
            if not SIGNATURE_MANIFEST_PATH.exists():
                json_response(
                    self,
                    HTTPStatus.NOT_FOUND,
                    {"ok": False, "error": "signature manifest not generated"},
                )
                return
            try:
                manifest = load_signature_manifest()
                json_response(self, HTTPStatus.OK, {"ok": True, "manifest": manifest})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if parsed_path.path == "/api/test-signatures":
            try:
                json_response(
                    self,
                    HTTPStatus.OK,
                    {"ok": True, "signatures": list_test_signatures()},
                )
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if parsed_path.path == "/api/patients":
            init_database()
            json_response(self, HTTPStatus.OK, {"ok": True, "patients": list_patients()})
            return
        if parsed_path.path.startswith("/api/session-page/"):
            init_database()
            try:
                patient_id = int(parsed_path.path.rsplit("/", 1)[1])
                json_response(self, HTTPStatus.OK, {"ok": True, **get_session_page(patient_id)})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if parsed_path.path.startswith("/api/patients/"):
            init_database()
            try:
                patient_id = int(parsed_path.path.rsplit("/", 1)[1])
            except ValueError:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "人名 ID 无效。"})
                return
            patient = get_patient(patient_id)
            if not patient:
                json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "没有找到这个人名。"})
                return
            json_response(self, HTTPStatus.OK, {"ok": True, "patient": patient})
            return
        if parsed_path.path == "/api/export.csv":
            init_database()
            body = export_csv()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header(
                "Content-Disposition",
                'attachment; filename="tuina_records.csv"',
            )
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def do_POST(self) -> None:
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == "/api/parse":
            try:
                request_json = read_json_body(self)
                text = str(request_json.get("text") or "")
                json_response(self, HTTPStatus.OK, {"ok": True, "parsed": parse_record_text(text)})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if parsed_path.path == "/api/transcribe":
            try:
                request_json = read_json_body(self)
                audio_base64 = str(request_json.get("audioBase64") or "")
                if "," in audio_base64:
                    audio_base64 = audio_base64.split(",", 1)[1]
                if not audio_base64:
                    raise ValueError("没有收到录音数据。")
                audio_bytes = base64.b64decode(audio_base64, validate=True)
                result = transcribe_audio(audio_bytes)
                json_response(self, HTTPStatus.OK, {"ok": True, **result})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if parsed_path.path == "/api/patients":
            try:
                init_database()
                request_json = read_json_body(self)
                patient = create_patient(request_json)
                json_response(self, HTTPStatus.OK, {"ok": True, "patient": patient})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if parsed_path.path == "/api/signatures":
            try:
                init_database()
                request_json = read_json_body(self)
                signature = save_electronic_signature(request_json)
                json_response(self, HTTPStatus.OK, {"ok": True, "signature": signature})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if parsed_path.path == "/api/test-signatures":
            try:
                request_json = read_json_body(self)
                signature = save_test_signature(request_json)
                json_response(self, HTTPStatus.OK, {"ok": True, "signature": signature})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if parsed_path.path.startswith("/api/session-adjustments/"):
            try:
                init_database()
                patient_id = int(parsed_path.path.rsplit("/", 1)[1])
                request_json = read_json_body(self)
                result = apply_session_adjustment(patient_id, request_json)
                json_response(self, HTTPStatus.OK, {"ok": True, **result})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if parsed_path.path.startswith("/api/patients/"):
            try:
                init_database()
                patient_id = int(parsed_path.path.rsplit("/", 1)[1])
                request_json = read_json_body(self)
                saved = save_patient(patient_id, request_json)
                json_response(self, HTTPStatus.OK, {"ok": True, "patient": saved})
            except Exception as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "接口不存在。"})

    def guess_type(self, path: str) -> str:
        if path.endswith(".js"):
            return "text/javascript"
        if path.endswith(".css"):
            return "text/css"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"[tuina] {self.address_string()} {format % args}\n")


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def run_server(host: str, port: int) -> None:
    load_dotenv()
    load_tencent_key_file()
    init_database()
    with ThreadedTCPServer((host, port), TuinaHandler) as server:
        print(f"Tuina input system: http://{host}:{port}", flush=True)
        print(f"Database: {DB_PATH}", flush=True)
        print("Press Ctrl+C to stop.", flush=True)
        server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Tuina patient input system.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8776)
    args = parser.parse_args()
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
