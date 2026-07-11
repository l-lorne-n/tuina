from __future__ import annotations

import re
import sqlite3
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


def normalize_request_id(value: Any) -> str:
    request_id = str(value or "").strip()
    if not request_id:
        raise ValueError("缺少 requestId，请刷新页面后重试")
    if len(request_id) > 128 or not re.fullmatch(r"[A-Za-z0-9._:-]+", request_id):
        raise ValueError("requestId 格式无效")
    return request_id


def optional_amount_cents(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        amount = Decimal(str(value).strip())
    except InvalidOperation as exc:
        raise ValueError(f"invalid amount: {value}") from exc
    cents = (amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    if amount != cents / Decimal(100):
        raise ValueError("金额最多保留两位小数")
    return int(cents)


def effective_adjustment_total(conn: sqlite3.Connection, patient_id: int) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(SUM(CASE WHEN operation = 'decrease' THEN -sessions ELSE sessions END), 0) AS total
        FROM session_adjustments
        WHERE patient_id = ? AND voided_at IS NULL AND correction_of_adjustment_id IS NULL
        """,
        (patient_id,),
    ).fetchone()
    return int(row["total"] or 0)


def verify_balance_invariants(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT p.id, COALESCE(p.remaining_sessions, 0) AS current_balance,
               COALESCE(p.opening_balance, 0) + COALESCE(SUM(
                   CASE WHEN a.id IS NULL THEN 0 WHEN a.operation = 'decrease' THEN -a.sessions ELSE a.sessions END
               ), 0) AS calculated_balance
        FROM patients p
        LEFT JOIN session_adjustments a ON a.patient_id = p.id
          AND a.voided_at IS NULL AND a.correction_of_adjustment_id IS NULL
        GROUP BY p.id
        HAVING current_balance != calculated_balance
        LIMIT 10
        """
    ).fetchall()
    if rows:
        ids = ", ".join(str(row["id"]) for row in rows)
        raise RuntimeError(f"患者余额一致性检查失败，患者 ID：{ids}")
