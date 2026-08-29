#!/usr/bin/env python

import re


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
