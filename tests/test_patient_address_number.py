import gc
import sqlite3
import tempfile
import unittest
from pathlib import Path

import server


class PatientAddressNumberTests(unittest.TestCase):
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

    def new_patient(self, name: str) -> dict:
        return server.create_patient({"name": name})

    def save_location(self, patient_id: int, address: str = "", record_no: str = "") -> dict:
        patient = server.get_patient(patient_id)
        return server.save_patient(
            patient_id,
            {
                **patient,
                "address": address,
                "recordNo": record_no,
                "recharges": patient["recharges"],
            },
        )

    def test_blank_numbers_can_repeat(self) -> None:
        first = self.new_patient("甲")
        second = self.new_patient("乙")

        self.save_location(first["id"], "", "")
        self.save_location(second["id"], "", "")

        summaries = server.list_patients()
        self.assertEqual([item["recordNo"] for item in summaries], [None, None])

    def test_nonblank_number_is_unique_within_address_group(self) -> None:
        first = self.new_patient("甲")
        second = self.new_patient("乙")
        third = self.new_patient("丙")

        self.save_location(first["id"], "浑南区", "12")
        with self.assertRaisesRegex(ValueError, "编号 12 已被"):
            self.save_location(second["id"], "浑南区", "12")
        saved_second = self.save_location(second["id"], "大东区", "12")
        saved_third = self.save_location(third["id"], "", "12")

        self.assertEqual(saved_second["recordNo"], 12)
        self.assertEqual(saved_third["address"], "")
        self.assertEqual(saved_third["recordNo"], 12)

    def test_address_and_number_validation(self) -> None:
        patient = self.new_patient("甲")

        with self.assertRaisesRegex(ValueError, "固定选项"):
            self.save_location(patient["id"], "不存在的区域", "1")
        with self.assertRaisesRegex(ValueError, "正整数"):
            self.save_location(patient["id"], "浑南区", "1.5")

    def test_settlement_snapshot_freezes_address_and_number(self) -> None:
        patient = self.new_patient("甲")
        saved = self.save_location(patient["id"], "浑南区", "8")
        server.apply_session_adjustment(
            saved["id"],
            {
                "operation": "decrease",
                "sessions": 1,
                "therapist": "王师傅",
                "occurredAt": "2026-07-02 10:00:00",
            },
        )
        settlement = server.create_settlement({"startDate": "2026-07-02", "endDate": "2026-07-02"})

        record = settlement["snapshot"]["records"][0]
        debt = settlement["snapshot"]["debts"][0]
        self.assertEqual((record["patientAddress"], record["patientRecordNo"]), ("浑南区", 8))
        self.assertEqual((debt["patientAddress"], debt["patientRecordNo"]), ("浑南区", 8))

    def test_database_backup_includes_number_and_settlement_snapshot(self) -> None:
        patient = self.new_patient("甲")
        self.save_location(patient["id"], "和平区", "3")
        server.create_settlement({"startDate": "2026-07-01", "endDate": "2026-07-01"})
        snapshot_path = Path(self.temp_dir.name) / "backup.sqlite3"

        server.create_database_snapshot(snapshot_path)

        conn = sqlite3.connect(snapshot_path)
        try:
            record_no = conn.execute("SELECT record_no FROM patients WHERE id = ?", (patient["id"],)).fetchone()[0]
            settlement_count = conn.execute("SELECT COUNT(*) FROM settlements").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(record_no, 3)
        self.assertEqual(settlement_count, 1)


class PatientSchemaMigrationTests(unittest.TestCase):
    def test_existing_patient_table_gets_nullable_record_number(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            original_db_path = server.DB_PATH
            original_excel_dir = server.EXCEL_DIR
            server.DB_PATH = Path(temp_dir) / "legacy.sqlite3"
            server.EXCEL_DIR = Path(temp_dir) / "no_excel"
            conn = sqlite3.connect(server.DB_PATH)
            try:
                conn.execute(
                    """
                    CREATE TABLE patients (
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
                conn.commit()
            finally:
                conn.close()

            try:
                server.init_database()
                conn = server.connect_db()
                try:
                    columns = {row["name"] for row in conn.execute("PRAGMA table_info(patients)")}
                    indexes = {row["name"] for row in conn.execute("PRAGMA index_list(patients)")}
                finally:
                    conn.close()
                self.assertIn("record_no", columns)
                self.assertIn("idx_patients_address_record_no_unique", indexes)
            finally:
                server.DB_PATH = original_db_path
                server.EXCEL_DIR = original_excel_dir
                gc.collect()


if __name__ == "__main__":
    unittest.main()
