import gc
import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

import server


class SettlementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = server.DB_PATH
        self.original_excel_dir = server.EXCEL_DIR
        server.DB_PATH = Path(self.temp_dir.name) / "test.sqlite3"
        server.EXCEL_DIR = Path(self.temp_dir.name) / "no_excel"
        server.init_database()
        self.debtor_id, self.recharge_patient_id, self.decrease_id = self.seed_records()

    def tearDown(self) -> None:
        server.DB_PATH = self.original_db_path
        server.EXCEL_DIR = self.original_excel_dir
        gc.collect()
        self.temp_dir.cleanup()

    def seed_records(self) -> tuple[int, int, int]:
        conn = server.connect_db()
        try:
            created_at = "2026-07-01 08:00:00"
            conn.execute(
                """
                INSERT INTO patients (
                    import_order, original_name, name, phone, remaining_sessions,
                    status, created_at, updated_at
                ) VALUES (1, '赊账患者', '赊账患者', '13800000000', -1, 'completed', ?, ?)
                """,
                (created_at, created_at),
            )
            debtor_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            conn.execute(
                """
                INSERT INTO patients (
                    import_order, original_name, name, remaining_sessions,
                    status, created_at, updated_at
                ) VALUES (2, '充值患者', '充值患者', 10, 'completed', ?, ?)
                """,
                (created_at, created_at),
            )
            recharge_patient_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            cursor = conn.execute(
                """
                INSERT INTO session_adjustments (
                    patient_id, operation, sessions, therapist, before_sessions, after_sessions,
                    signature_status, occurred_at, created_at
                ) VALUES (?, 'decrease', 1, '王师傅', 0, -1, 'signed', ?, ?)
                """,
                (debtor_id, "2026-07-02 10:00:00", "2026-07-02 10:00:00"),
            )
            decrease_id = int(cursor.lastrowid)
            conn.execute(
                """
                INSERT INTO session_adjustments (
                    patient_id, operation, sessions, amount, before_sessions, after_sessions,
                    signature_status, occurred_at, created_at
                ) VALUES (?, 'increase', 10, 900, 0, 10, 'signed', ?, ?)
                """,
                (recharge_patient_id, "2026-07-01 09:00:00", "2026-07-01 09:00:00"),
            )
            conn.execute(
                """
                INSERT INTO session_adjustments (
                    patient_id, operation, sessions, therapist, before_sessions, after_sessions,
                    signature_status, voided_at, correction_reason, occurred_at, created_at
                ) VALUES (?, 'decrease', 2, '杨师傅', 10, 8, 'signed', ?, '手误', ?, ?)
                """,
                (
                    recharge_patient_id,
                    "2026-07-03 11:05:00",
                    "2026-07-03 11:00:00",
                    "2026-07-03 11:00:00",
                ),
            )
            conn.commit()
            return debtor_id, recharge_patient_id, decrease_id
        finally:
            conn.close()

    def test_snapshot_keeps_voided_rows_but_excludes_them_from_totals(self) -> None:
        settlement = server.create_settlement({"startDate": "2026-07-01", "endDate": "2026-07-03"})
        snapshot = settlement["snapshot"]

        self.assertEqual(snapshot["summary"]["recordCount"], 3)
        self.assertEqual(snapshot["summary"]["rechargeSessions"], 10)
        self.assertEqual(snapshot["summary"]["massageSessions"], 1)
        self.assertEqual(snapshot["therapistStats"][0]["workSessions"], 1)
        self.assertEqual(snapshot["therapistStats"][1]["workSessions"], 0)
        self.assertTrue(any(item["isVoided"] for item in snapshot["records"]))
        self.assertEqual(snapshot["debts"][0]["patientId"], self.debtor_id)
        self.assertEqual(snapshot["debts"][0]["debtSince"], "2026-07-02 10:00:00")

    def test_only_latest_settlement_can_be_revoked(self) -> None:
        first = server.create_settlement({"startDate": "2026-07-01", "endDate": "2026-07-03"})
        second = server.create_settlement({"startDate": "2026-07-04", "endDate": "2026-07-05"})

        with self.assertRaisesRegex(ValueError, "只能撤销最后一份"):
            server.revoke_settlement(first["id"], {"reason": "日期选错"})

        server.revoke_settlement(second["id"], {"reason": "日期选错"})
        refreshed_first = server.get_settlement(first["id"])
        self.assertTrue(refreshed_first["canRevoke"])
        self.assertEqual(server.list_settlements()["defaults"]["startDate"], "2026-07-04")

    def test_settled_dates_reject_new_or_reversed_adjustments(self) -> None:
        server.create_settlement({"startDate": "2026-07-01", "endDate": "2026-07-03"})

        with self.assertRaisesRegex(ValueError, "已进入月结"):
            server.apply_session_adjustment(
                self.debtor_id,
                {
                    "operation": "decrease",
                    "sessions": 1,
                    "therapist": "王师傅",
                    "occurredAt": "2026-07-03 15:00:00",
                },
            )
        with self.assertRaisesRegex(ValueError, "已进入月结"):
            server.reverse_session_adjustment(self.decrease_id, {"reason": "手误"})


class SettlementApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = server.DB_PATH
        self.original_excel_dir = server.EXCEL_DIR
        server.DB_PATH = Path(self.temp_dir.name) / "api-test.sqlite3"
        server.EXCEL_DIR = Path(self.temp_dir.name) / "no_excel"
        server.init_database()
        self.httpd = server.ThreadedTCPServer(("127.0.0.1", 0), server.TuinaHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server.DB_PATH = self.original_db_path
        server.EXCEL_DIR = self.original_excel_dir
        gc.collect()
        self.temp_dir.cleanup()

    def request_json(self, path: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
            method="POST" if data is not None else "GET",
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_create_read_list_and_revoke_routes(self) -> None:
        created = self.request_json(
            "/api/settlements",
            {"startDate": "2026-07-01", "endDate": "2026-07-01"},
        )
        settlement_id = created["settlement"]["id"]

        listing = self.request_json("/api/settlements")
        detail = self.request_json(f"/api/settlements/{settlement_id}")
        revoked = self.request_json(
            f"/api/settlements/{settlement_id}/revoke",
            {"reason": "日期选错"},
        )

        self.assertTrue(created["ok"])
        self.assertEqual(listing["settlements"][0]["id"], settlement_id)
        self.assertEqual(detail["settlement"]["snapshot"]["summary"]["recordCount"], 0)
        self.assertEqual(revoked["revokedId"], settlement_id)
        self.assertEqual(revoked["settlements"], [])


if __name__ == "__main__":
    unittest.main()
