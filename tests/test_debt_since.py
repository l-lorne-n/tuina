import gc
import tempfile
import unittest
from pathlib import Path

import server


class DebtSinceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = server.DB_PATH
        self.original_excel_dir = server.EXCEL_DIR
        server.DB_PATH = Path(self.temp_dir.name) / "test.sqlite3"
        server.EXCEL_DIR = Path(self.temp_dir.name) / "no_excel"
        server.init_database()

    def tearDown(self) -> None:
        server.DB_PATH = self.original_db_path
        server.EXCEL_DIR = self.original_excel_dir
        gc.collect()
        self.temp_dir.cleanup()

    def test_uses_start_of_current_negative_balance_period(self) -> None:
        conn = server.connect_db()
        try:
            conn.execute(
                """
                INSERT INTO patients (
                    import_order, original_name, name, phone, remaining_sessions,
                    status, created_at, updated_at
                ) VALUES (1, '测试患者', '测试患者', '13800000000', -2, 'completed', ?, ?)
                """,
                ("2026-07-01 08:00:00", "2026-07-11 10:00:00"),
            )
            patient_id = int(conn.execute("SELECT id FROM patients").fetchone()["id"])
            adjustments = [
                ("decrease", 1, "2026-07-10 08:00:00", None),
                ("increase", 1, "2026-07-10 09:00:00", None),
                ("decrease", 2, "2026-07-11 10:00:00", None),
                ("decrease", 5, "2026-07-11 11:00:00", "2026-07-11 11:05:00"),
            ]
            for operation, sessions, occurred_at, voided_at in adjustments:
                conn.execute(
                    """
                    INSERT INTO session_adjustments (
                        patient_id, operation, sessions, after_sessions,
                        occurred_at, created_at, voided_at
                    ) VALUES (?, ?, ?, 0, ?, ?, ?)
                    """,
                    (patient_id, operation, sessions, occurred_at, occurred_at, voided_at),
                )
            conn.commit()
        finally:
            conn.close()

        debts = server.list_debtor_patients()

        self.assertEqual(len(debts), 1)
        self.assertEqual(debts[0]["debtSince"], "2026-07-11 10:00:00")
        self.assertEqual(debts[0]["owedSessions"], 2)


if __name__ == "__main__":
    unittest.main()
