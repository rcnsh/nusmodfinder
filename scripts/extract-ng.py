#!/usr/bin/env python3
"""Extract the Non-Graduating (exchange student) course list from the NUS PDF.

The list lives only in a PDF on nus.edu.sg, which sits behind bot protection and
cannot be fetched programmatically. So the PDF is downloaded by hand and this
script turns it into a committed JSON artifact that the ingest script reads.

    python3 -m venv .venv && .venv/bin/pip install pypdf
    .venv/bin/python scripts/extract-ng.py ~/Downloads/ng-courses.pdf

The document is one row per offering:
    Faculty | Centre/Department/Programme | Course Code | Course Title | Class Nbr | Class Schedule
split into two sections, one per semester, each introduced by a heading naming
the intake. Semester is tracked from those headings rather than from page
numbers, so re-paginating the PDF next year does not silently corrupt the split.
"""
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

# Two to four letters, four digits, optional suffix. "AY2026" matches that shape
# and appears in every page header, so it is excluded explicitly.
CODE_RE = re.compile(r'\b(?!AY\d)([A-Z]{2,4}\d{4}[A-Z0-9]{0,3})\b')
SECTION_RE = re.compile(r'For Semester (\d) of AY(\d{4})/(\d{4})\s*\((?:January|August)', re.I)

def main() -> int:
    pdf_path = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / 'Downloads' / 'ng-courses.pdf'
    if not pdf_path.exists():
        print(f'No such file: {pdf_path}', file=sys.stderr)
        return 1

    reader = PdfReader(str(pdf_path))
    semester = None
    acad_year = None
    by_sem: dict[int, set[str]] = {}
    updated = None

    for page in reader.pages:
        text = page.extract_text() or ''
        if updated is None:
            m = re.search(r'Updated as at (\d{1,2} \w{3} \d{4})', text)
            if m:
                updated = m.group(1)
        for line in text.split('\n'):
            section = SECTION_RE.search(line)
            if section:
                semester = int(section.group(1))
                acad_year = f'{section.group(2)}-{section.group(3)}'
                by_sem.setdefault(semester, set())
                continue
            if semester is None:
                continue
            # The repeated navigation header names both semesters; skip it so it
            # cannot be mistaken for data.
            if 'Page 1 to Page' in line or 'P a g e' in line:
                continue
            for code in CODE_RE.findall(line):
                by_sem[semester].add(code)

    if not by_sem:
        print('No semester sections found — the PDF layout has changed.', file=sys.stderr)
        return 1

    out = {
        'source': 'NUS Registrar, "Course Offered for Non-Graduating (NG) Students"',
        'sourceFile': pdf_path.name,
        'updatedAsAt': updated,
        'acadYear': acad_year,
        'semesters': {str(s): sorted(c) for s, c in sorted(by_sem.items())},
    }
    all_codes = sorted(set().union(*by_sem.values()))
    out['allCodes'] = all_codes

    dest = Path(__file__).resolve().parent.parent / 'data' / f'ng-courses-{acad_year}.json'
    dest.write_text(json.dumps(out, indent=2) + '\n')

    print(f'source        {pdf_path}')
    print(f'acad year     {acad_year}   (updated as at {updated})')
    for s, codes in sorted(by_sem.items()):
        print(f'semester {s}    {len(codes)} distinct course codes')
    print(f'union         {len(all_codes)} distinct course codes')
    print(f'wrote         {dest.relative_to(dest.parent.parent)}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
