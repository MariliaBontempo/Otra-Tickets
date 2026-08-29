import hashlib
import inspect
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.ticket_number_extractor.extract_ticket_numbers import (
    PageValidationError,
    build_report,
    extract_page_texts,
    file_sha256,
    parse_page_number,
    write_report,
)


class ParsePageNumberTests(unittest.TestCase):
    def test_returns_one_repeated_number_and_preserves_leading_zeroes(self):
        page_text = "KAYA-KAYA-2026-PRINT-000001\n00042 00042\n"

        self.assertEqual(parse_page_number(page_text), "00042")

    def test_rejects_page_without_numeric_pair(self):
        with self.assertRaisesRegex(PageValidationError, r"^missing numeric pair$"):
            parse_page_number("KAYA-KAYA-2026-PRINT-000001\n")

    def test_rejects_non_pair_numeric_lines(self):
        for line in (
            "ticket 39223 39223",
            "39223 39223 suffix",
            "39223 39223 39223",
        ):
            with self.subTest(line=line):
                with self.assertRaisesRegex(
                    PageValidationError, r"^missing numeric pair$"
                ):
                    parse_page_number(line + "\n")

    def test_rejects_mismatched_printed_values(self):
        with self.assertRaisesRegex(
            PageValidationError,
            r"^mismatched printed values: '39223' and '39224'$",
        ):
            parse_page_number("39223 39224\n")

    def test_parse_page_number_has_annotated_signature(self):
        signature = inspect.signature(parse_page_number)

        self.assertEqual(
            signature,
            inspect.Signature(
                parameters=[
                    inspect.Parameter(
                        "text",
                        inspect.Parameter.POSITIONAL_OR_KEYWORD,
                        annotation=str,
                    )
                ],
                return_annotation=str,
            ),
        )

    def test_rejects_more_than_one_numeric_pair(self):
        with self.assertRaisesRegex(PageValidationError, r"^multiple numeric pairs$"):
            parse_page_number("39223 39223\n39224 39224\n")


class BuildReportTests(unittest.TestCase):
    def test_tracks_duplicates_by_page_and_builds_validation_counts(self):
        report = build_report(
            source_filename="tickets.pdf",
            source_sha256="abc123",
            page_count=4,
            extracted=[(1, "00042"), (2, "00043"), (4, "00042")],
            invalid_pages=[{"page": 3, "reason": "missing numeric pair"}],
        )

        self.assertEqual(report["numbers"], ["00042", "00043", "00042"])
        self.assertEqual(
            list(report), ["source", "numbers", "duplicates", "validation"]
        )
        self.assertEqual(
            report["duplicates"],
            [{"number": "00042", "occurrences": 2, "pages": [1, 4]}],
        )
        self.assertEqual(
            report["source"], {"filename": "tickets.pdf", "sha256": "abc123"}
        )
        self.assertEqual(
            report["validation"],
            {
                "page_count": 4,
                "valid_page_count": 3,
                "invalid_page_count": 1,
                "extracted_number_count": 3,
                "unique_number_count": 2,
                "duplicate_number_count": 1,
                "duplicate_extra_occurrence_count": 1,
                "invalid_pages": [{"page": 3, "reason": "missing numeric pair"}],
            },
        )

    def test_sorts_duplicate_pages_without_sorting_numbers(self):
        report = build_report(
            source_filename="tickets.pdf",
            source_sha256="abc123",
            page_count=5,
            extracted=[
                (4, "00042"),
                (2, "00043"),
                (1, "00042"),
                (5, "00001"),
                (3, "00001"),
            ],
            invalid_pages=[],
        )

        self.assertEqual(
            report["numbers"], ["00042", "00043", "00042", "00001", "00001"]
        )
        self.assertEqual(
            report["duplicates"],
            [
                {"number": "00042", "occurrences": 2, "pages": [1, 4]},
                {"number": "00001", "occurrences": 2, "pages": [3, 5]},
            ],
        )

    def test_snapshots_invalid_page_dictionaries(self):
        invalid_page = {"page": 3, "reason": "missing numeric pair"}

        report = build_report(
            source_filename="tickets.pdf",
            source_sha256="abc123",
            page_count=4,
            extracted=[(1, "00042"), (2, "00043"), (4, "00042")],
            invalid_pages=[invalid_page],
        )

        invalid_page["reason"] = "changed after report"

        self.assertEqual(
            report["validation"]["invalid_pages"],
            [{"page": 3, "reason": "missing numeric pair"}],
        )


class FileOutputTests(unittest.TestCase):
    def test_hashes_source_bytes(self):
        with TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.bin"
            source_path.write_bytes(b"abc")

            self.assertEqual(
                file_sha256(source_path),
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            )

    def test_hashes_bytes_larger_than_one_megabyte(self):
        payload = b"a" * (1024 * 1024) + b"b"

        with TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.bin"
            source_path.write_bytes(payload)

            self.assertEqual(
                file_sha256(source_path), hashlib.sha256(payload).hexdigest()
            )

    def test_writes_stable_json(self):
        report = {
            "source": {"filename": "caf\u00e9.bin", "sha256": "abc123"},
            "numbers": ["00042"],
            "duplicates": [],
            "validation": {"page_count": 1},
        }

        with TemporaryDirectory() as directory:
            output_path = Path(directory) / "nested" / "report.json"
            write_report(report, output_path)

            output_text = output_path.read_text(encoding="utf-8")
            self.assertIn(r"\u00e9", output_text)
            self.assertEqual(json.loads(output_text), report)
            self.assertEqual(
                output_text,
                json.dumps(report, indent=2, ensure_ascii=True) + "\n",
            )


class ExtractPageTextsTests(unittest.TestCase):
    def test_collects_valid_values_and_invalid_page_reasons(self):
        extracted, invalid_pages = extract_page_texts(
            text for text in ("100 100\n", "200 201\n", "300 300\n")
        )

        self.assertEqual(extracted, [(1, "100"), (3, "300")])
        self.assertEqual(
            invalid_pages,
            [{"page": 2, "reason": "mismatched printed values: '200' and '201'"}],
        )
