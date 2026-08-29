import inspect
import unittest

from scripts.ticket_number_extractor.extract_ticket_numbers import (
    PageValidationError,
    build_report,
    parse_page_number,
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
        with self.assertRaisesRegex(
            PageValidationError, r"^multiple numeric pairs$"
        ):
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
