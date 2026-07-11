import concurrent.futures
import base64
import gc
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import server


class LedgerSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.originals = {
            "DB_PATH": server.DB_PATH,
            "EXCEL_DIR": server.EXCEL_DIR,
            "BACKUP_TEMP_DIR": server.BACKUP_TEMP_DIR,
            "ELECTRONIC_SIGNATURE_DIR": server.ELECTRONIC_SIGNATURE_DIR,
            "SIGNATURE_BINDINGS_PATH": server.SIGNATURE_BINDINGS_PATH,
            "SIGNATURE_MANIFEST_PATH": server.SIGNATURE_MANIFEST_PATH,
        }
        root = Path(self.temp_dir.name)
        server.DB_PATH = root / "data" / "test.sqlite3"
        server.EXCEL_DIR = root / "no_excel"
        server.BACKUP_TEMP_DIR = root / "backup_tmp"
        server.ELECTRONIC_SIGNATURE_DIR = root / "signatures" / "electronic"
        server.SIGNATURE_BINDINGS_PATH = root / "signatures" / "bindings.json"
        server.SIGNATURE_MANIFEST_PATH = root / "signatures" / "manifest.json"
        server.init_database()
        self.patient = server.create_patient({"name": "安全测试"})

    def tearDown(self) -> None:
        for key, value in self.originals.items():
            setattr(server, key, value)
        gc.collect()
        self.temp_dir.cleanup()

    def test_opening_balance_then_active_correction_is_auditable(self) -> None:
        patient_id = self.patient["id"]
        first = server.correct_opening_balance(
            patient_id,
            {"openingBalance": 3, "reason": "纸质卡片核对", "requestId": "opening-1"},
        )
        duplicate = server.correct_opening_balance(
            patient_id,
            {"openingBalance": 99, "reason": "重复请求", "requestId": "opening-1"},
        )
        self.assertEqual(first["remainingSessions"], 3)
        self.assertEqual(duplicate["remainingSessions"], 3)

        server.confirm_patient_balance(patient_id, {"requestId": "confirm-1"})
        saved = server.save_patient(
            patient_id,
            {**server.get_patient(patient_id), "name": "改名后", "remainingSessions": 99},
        )
        self.assertEqual(saved["remainingSessions"], 3)

        corrected = server.correct_active_balance(
            patient_id,
            {"targetBalance": 5, "reason": "上线余额复核", "requestId": "balance-1"},
        )
        duplicate = server.correct_active_balance(
            patient_id,
            {"targetBalance": 100, "reason": "上线余额复核", "requestId": "balance-1"},
        )
        self.assertEqual(corrected["patient"]["remainingSessions"], 5)
        self.assertEqual(duplicate["patient"]["remainingSessions"], 5)
        self.assertTrue(corrected["adjustment"]["isBalanceCorrection"])
        self.assertEqual(corrected["adjustment"]["signatureStatus"], "not_required")

        summary = server.build_session_summary({"range": ["year"], "date": ["2026"]})
        self.assertEqual(summary["summary"]["rechargeSessions"], 0)
        self.assertEqual(summary["summary"]["massageSessions"], 0)

    def test_same_adjustment_request_only_changes_balance_once(self) -> None:
        patient_id = self.patient["id"]
        payload = {"operation": "increase", "sessions": 10, "amount": "900.00", "requestId": "same-add"}

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: server.apply_session_adjustment(patient_id, payload), range(2)))

        self.assertEqual({item["adjustment"]["id"] for item in results}, {results[0]["adjustment"]["id"]})
        self.assertEqual(server.get_patient(patient_id)["remainingSessions"], 10)
        with server.connect_db() as conn:
            count = conn.execute("SELECT COUNT(*) FROM session_adjustments").fetchone()[0]
            cents = conn.execute("SELECT amount_cents FROM session_adjustments").fetchone()[0]
        self.assertEqual(count, 1)
        self.assertEqual(cents, 90000)

    def test_failed_adjustment_rolls_back_balance(self) -> None:
        patient_id = self.patient["id"]
        with server.connect_db() as conn:
            conn.execute(
                "CREATE TRIGGER fail_adjustment BEFORE INSERT ON session_adjustments BEGIN SELECT RAISE(ABORT, 'forced'); END"
            )
        with self.assertRaises(Exception):
            server.apply_session_adjustment(
                patient_id,
                {"operation": "increase", "sessions": 2, "amount": 180, "requestId": "rollback-1"},
            )
        self.assertEqual(server.get_patient(patient_id)["remainingSessions"], 0)

    def test_reverse_request_is_idempotent(self) -> None:
        patient_id = self.patient["id"]
        created = server.apply_session_adjustment(
            patient_id,
            {"operation": "increase", "sessions": 4, "amount": 360, "requestId": "add-before-reverse"},
        )
        adjustment_id = created["adjustment"]["id"]
        first = server.reverse_session_adjustment(adjustment_id, {"reason": "手误", "requestId": "reverse-1"})
        second = server.reverse_session_adjustment(adjustment_id, {"reason": "手误", "requestId": "reverse-1"})
        self.assertEqual(first["patient"]["remainingSessions"], 0)
        self.assertEqual(second["patient"]["remainingSessions"], 0)

    def test_settlement_and_adjustment_race_stays_consistent(self) -> None:
        patient_id = self.patient["id"]
        date = server.dt.date.today().isoformat()

        def create_adjustment():
            try:
                return server.apply_session_adjustment(
                    patient_id,
                    {
                        "operation": "increase",
                        "sessions": 1,
                        "amount": 90,
                        "occurredAt": f"{date} 09:00:00",
                        "requestId": "race-adjustment",
                    },
                )
            except ValueError:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            settlement_future = pool.submit(
                server.create_settlement,
                {"startDate": date, "endDate": date, "requestId": "race-settlement"},
            )
            adjustment_future = pool.submit(create_adjustment)
            settlement = settlement_future.result()
            adjustment = adjustment_future.result()

        record_ids = {item["id"] for item in settlement["snapshot"]["records"] if item["operation"] != "legacy_recharge"}
        if adjustment is not None:
            self.assertIn(adjustment["adjustment"]["id"], record_ids)
        else:
            self.assertEqual(record_ids, set())

    def test_connection_pragmas_and_migration_record(self) -> None:
        with server.connect_db() as conn:
            self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(conn.execute("PRAGMA busy_timeout").fetchone()[0], 15000)
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
            versions = conn.execute("SELECT version FROM schema_migrations").fetchall()
        self.assertTrue(versions)

    def test_full_signature_baseline_contains_unchanged_files(self) -> None:
        signature = server.ELECTRONIC_SIGNATURE_DIR / "flow" / "old.png"
        signature.parent.mkdir(parents=True, exist_ok=True)
        signature.write_bytes(b"old-signature")
        server.SIGNATURE_BINDINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        server.SIGNATURE_BINDINGS_PATH.write_text("{}", encoding="utf-8")
        server.SIGNATURE_MANIFEST_PATH.write_text("{}", encoding="utf-8")
        state = {"uploadedSignatureFiles": {server.backup_archive_name(signature): server.signature_backup_record(signature)}}
        zip_path = Path(self.temp_dir.name) / "baseline.zip"

        paths, updated = server.create_backup_zip(zip_path, state, full_baseline=True)

        self.assertEqual(paths, [signature])
        self.assertIn("lastFullSignatureBaselineAt", updated)
        with zipfile.ZipFile(zip_path) as package:
            manifest = json.loads(package.read("backup_manifest.json"))
            self.assertEqual(manifest["signatureMode"], "full")
            self.assertIn(server.backup_archive_name(signature), package.namelist())
        restored = Path(self.temp_dir.name) / "restored"
        report = server.verify_backup_restore_chain([zip_path], restored)
        self.assertEqual(report["integrity"], "ok")
        self.assertEqual((restored / server.backup_archive_name(signature)).read_bytes(), b"old-signature")

    def test_failed_bulk_signature_compensates_file_and_bindings(self) -> None:
        server.SIGNATURE_BINDINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        original = b'{"patients": {}}'
        server.SIGNATURE_BINDINGS_PATH.write_bytes(original)
        image = base64.b64encode(b"\x89PNG\r\n\x1a\ninvalid-but-header-ok").decode("ascii")
        with self.assertRaises(ValueError):
            server.save_bulk_flow_signature(
                {
                    "adjustmentIds": [999],
                    "imageData": f"data:image/png;base64,{image}",
                    "requestId": "bulk-failure",
                }
            )
        self.assertEqual(server.SIGNATURE_BINDINGS_PATH.read_bytes(), original)
        self.assertEqual(list(server.ELECTRONIC_SIGNATURE_DIR.rglob("*.png")), [])


if __name__ == "__main__":
    unittest.main()
