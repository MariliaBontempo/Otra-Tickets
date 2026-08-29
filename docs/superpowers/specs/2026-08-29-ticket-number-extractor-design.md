# PDF ticket number extractor design

## Goal

Create a deterministic command-line utility that extracts the numeric value printed
twice below the QR code on every page of a ticket PDF. The utility must retain one
number per page, identify values repeated across pages, and write a JSON report with
the extracted values and validation counts.

The supplied source PDF is
`/Users/brianarbuckle/Downloads/kaya-ticket-art-5000-14x5cm.pdf`. It contains 5,000
pages and exposes the printed ticket values as embedded text, so the utility will not
use OCR or image recognition.

## Location and interface

The implementation will live in the `Otra-Tickets` repository:

- `scripts/ticket_number_extractor/extract_ticket_numbers.py`: command-line entry
  point and extraction logic
- `scripts/ticket_number_extractor/requirements.txt`: the `pypdf` dependency
- `scripts/ticket_number_extractor/tests/test_extract_ticket_numbers.py`: standard
  library `unittest` coverage
- `output/kaya-ticket-art-5000-14x5cm-ticket-numbers.json`: generated report for the
  supplied PDF

The command will accept an input PDF and an explicit output path:

```bash
python scripts/ticket_number_extractor/extract_ticket_numbers.py \
  /path/to/tickets.pdf \
  --output /path/to/report.json
```

Numbers will be stored as strings so leading zeroes remain intact.

## Extraction and validation

`pypdf.PdfReader` will extract embedded text from each page. The page parser will
look for a line containing exactly two numeric tokens. It will accept the page only
when:

1. exactly one numeric-pair line is present;
2. both printed values on that line are identical; and
3. the value contains digits only.

The accepted value is recorded once for that page. The duplicate detector then
compares these page-level values. The intentional second printing on the same page
does not count as a duplicate.

Every invalid page will be recorded with its one-based page number and a concrete
reason, such as a missing numeric pair, mismatched printed values, or multiple
candidate lines. The utility will still write the diagnostic report, then exit with
status 1. File access, PDF parsing, or output errors will print a concise error and
exit with status 2.

## JSON report

The report will have this shape:

```json
{
  "source": {
    "filename": "kaya-ticket-art-5000-14x5cm.pdf",
    "sha256": "<source file digest>"
  },
  "numbers": ["39223", "39224"],
  "duplicates": [
    {
      "number": "39223",
      "occurrences": 2,
      "pages": [1, 400]
    }
  ],
  "validation": {
    "page_count": 5000,
    "valid_page_count": 5000,
    "invalid_page_count": 0,
    "extracted_number_count": 5000,
    "unique_number_count": 5000,
    "duplicate_number_count": 0,
    "duplicate_extra_occurrence_count": 0,
    "invalid_pages": []
  }
}
```

`duplicates` will contain one object per number found on more than one page. Its
`pages` list will preserve ascending PDF page order. `duplicate_extra_occurrence_count`
will count occurrences beyond the first for each duplicated number.

The JSON will use stable indentation and preserve PDF page order. The source SHA-256
digest will tie the output to the exact input file.

## Tests and acceptance

Unit tests will be written before implementation and will cover:

- one valid repeated number per page;
- preservation of leading zeroes;
- missing, mismatched, and ambiguous numeric-pair lines;
- one output number per valid page;
- duplicate page tracking and both duplicate counts;
- validation counts when invalid pages are present; and
- JSON serialization.

Acceptance for the supplied PDF requires:

- the extractor exits with status 0;
- `page_count`, `valid_page_count`, and `extracted_number_count` are all 5,000;
- `invalid_page_count` is 0;
- the report contains 5,000 page-ordered numbers;
- duplicate counts agree with an independent count of the `numbers` array; and
- a second run produces identical JSON.

