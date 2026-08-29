#!/usr/bin/env python

import re
from collections import defaultdict
from typing import Sequence


NUMERIC_PAIR_PATTERN = re.compile(r"^[ \t]*(\d+)[ \t]+(\d+)[ \t]*$")


class PageValidationError(ValueError):
    """Raised when a PDF page does not contain one valid repeated number pair."""


def parse_page_number(text: str) -> str:
    pairs: list[tuple[str, str]] = []
    for line in text.splitlines():
        match = NUMERIC_PAIR_PATTERN.fullmatch(line)
        if match:
            pairs.append((match.group(1), match.group(2)))

    if not pairs:
        raise PageValidationError("missing numeric pair")
    if len(pairs) > 1:
        raise PageValidationError("multiple numeric pairs")

    left, right = pairs[0]
    if left != right:
        raise PageValidationError(f"mismatched printed values: {left!r} and {right!r}")
    return left


def build_report(
    *,
    source_filename: str,
    source_sha256: str,
    page_count: int,
    extracted: Sequence[tuple[int, str]],
    invalid_pages: Sequence[dict[str, object]],
) -> dict[str, object]:
    pages_by_number: defaultdict[str, list[int]] = defaultdict(list)
    numbers: list[str] = []
    for page, number in extracted:
        numbers.append(number)
        pages_by_number[number].append(page)

    duplicates = [
        {"number": number, "occurrences": len(pages), "pages": pages}
        for number, pages in pages_by_number.items()
        if len(pages) > 1
    ]
    invalid_page_list = list(invalid_pages)

    return {
        "numbers": numbers,
        "duplicates": duplicates,
        "source": {"filename": source_filename, "sha256": source_sha256},
        "validation": {
            "page_count": page_count,
            "valid_page_count": len(extracted),
            "invalid_page_count": len(invalid_page_list),
            "extracted_number_count": len(numbers),
            "unique_number_count": len(pages_by_number),
            "duplicate_number_count": len(duplicates),
            "duplicate_extra_occurrence_count": sum(
                len(pages) - 1 for pages in pages_by_number.values() if len(pages) > 1
            ),
            "invalid_pages": invalid_page_list,
        },
    }
