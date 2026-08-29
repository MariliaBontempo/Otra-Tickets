import inspect
import unittest

from scripts.ticket_number_extractor.extract_ticket_numbers import (
    PageValidationError,
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
