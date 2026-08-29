#!/usr/bin/env python

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PdfReadError

NUMERIC_PAIR_PATTERN = re.compile(r"^[ \t]*(\d+)[ \t]+(\d+)[ \t]*$")


class PageValidationError(ValueError):
    """Raised when a PDF page does not contain one valid repeated number pair."""


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_report(report: dict[str, object], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )


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


def extract_page_texts(
    page_texts: Iterable[str],
) -> tuple[list[tuple[int, str]], list[dict[str, object]]]:
    extracted: list[tuple[int, str]] = []
    invalid_pages: list[dict[str, object]] = []
    for page, text in enumerate(page_texts, start=1):
        try:
            extracted.append((page, parse_page_number(text)))
        except PageValidationError as error:
            invalid_pages.append({"page": page, "reason": str(error)})
    return extracted, invalid_pages


def extract_pdf(
    input_path: Path,
) -> tuple[int, list[tuple[int, str]], list[dict[str, object]]]:
    reader = PdfReader(input_path)
    extracted, invalid_pages = extract_page_texts(
        page.extract_text() or "" for page in reader.pages
    )
    return len(reader.pages), extracted, invalid_pages


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
        {"number": number, "occurrences": len(pages), "pages": sorted(pages)}
        for number, pages in pages_by_number.items()
        if len(pages) > 1
    ]
    invalid_page_list = [dict(item) for item in invalid_pages]

    return {
        "source": {"filename": source_filename, "sha256": source_sha256},
        "numbers": numbers,
        "duplicates": duplicates,
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


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract repeated ticket numbers from PDF pages."
    )
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        page_count, extracted, invalid_pages = extract_pdf(args.input_pdf)
        report = build_report(
            source_filename=args.input_pdf.name,
            source_sha256=file_sha256(args.input_pdf),
            page_count=page_count,
            extracted=extracted,
            invalid_pages=invalid_pages,
        )
        write_report(report, args.output)
    except (OSError, PdfReadError) as error:
        print(f"could not process PDF: {error}", file=sys.stderr)
        return 2

    print(
        f"wrote {args.output}: {len(extracted)} numbers, "
        f"{len(report['duplicates'])} duplicate values, "
        f"{len(invalid_pages)} invalid pages"
    )
    return 1 if invalid_pages else 0


if __name__ == "__main__":
    raise SystemExit(main())
