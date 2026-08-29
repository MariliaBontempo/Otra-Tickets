# Ticket number extractor

This script extracts embedded text from each PDF page. Each page must contain
one line with two identical printed numeric values, such as `00042 00042`.
It validates that there is exactly one pair and that the two values match.
Duplicate ticket numbers are counted only when the same value appears on more
than one page.

## Setup

If `pypdf` is not already available, install the pinned dependency:

```sh
python -m pip install -r scripts/ticket_number_extractor/requirements.txt
```

## Run

```sh
python scripts/ticket_number_extractor/extract_ticket_numbers.py input.pdf --output report.json
```

The JSON report includes `numbers`, a list of extracted values; `duplicates`,
the duplicate values with their page occurrences; and `validation`, the page
counts and invalid-page details. Ticket numbers are strings, preserving leading
zeroes.

The script exits with 0 when every page is valid, 1 when one or more pages are
invalid and the report was written, or 2 when it could not process the PDF.
