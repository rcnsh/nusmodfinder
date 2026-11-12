#!/usr/bin/env python3
"""Extract the Non-Graduating (exchange student) course list from the NUS PDF.

The list lives only in a PDF on nus.edu.sg, which sits behind bot protection and
cannot be fetched programmatically. So the PDF is downloaded by hand and this
script turns it into a committed JSON artifact that the ingest script reads.

    python3 -m venv .venv && .venv/bin/pip install pypdf
    .venv/bin/python scripts/extract-ng.py <dir>/ng-courses.pdf --year <yyyy-yyyy>
    python3 scripts/extract-ng.py --from-text <pages.txt> --year <yyyy-yyyy> [--out <file>]

The document is one row per offering:
    Faculty | Centre/Department/Programme | Course Code | Course Title | Class Nbr | Class Schedule
split into sections, one per semester, each introduced by a heading naming the
intake ("For Semester 1 of AY<yyyy>/<yyyy> (August <yyyy> ...)"). Semester is tracked
from those headings rather than from page numbers, so re-paginating the PDF next
year does not silently corrupt the split.

Only the sections whose heading names the
target year are kept, August of its first year for Sem 1 and January of its
second for Sem 2. NUS prepends new sections, so an April PDF can hold Sem 1 of
the next year above Sem 2 of this one; the others are dropped and listed. The
run fails when a semester the year's source manifest marks published has no
section, or a kept section has no rows, and prints each semester's count.

--from-text reads text already extracted (pages separated by form feeds, as
pdftotext writes them) and needs no pypdf, so CI tests the heading logic.

`npm run year -- check --full` re-runs this script with .venv/bin/python on the
archived PDF and requires its output to be data/ng-courses-<year>.json byte for
byte, so create the venv as above before running it.
--published 1,2 overrides the manifest's published semesters
(data/ng-sources-<year>.json). --out writes somewhere other than
data/ng-courses-<year>.json.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Two to four letters, four digits, optional suffix. "AY2026" matches that shape
# and appears in every page header, so it is excluded explicitly.
CODE_RE = re.compile(r'\b(?!AY\d)([A-Z]{2,4}\d{4}[A-Z0-9]{0,3})\b')
SECTION_RE = re.compile(r'For Semester (\d) of AY(\d{4})/(\d{4})\s*\((January|August)(?:\s+(\d{4}))?', re.I)
YEAR_RE = re.compile(r'^(\d{4})-(\d{4})$')


def pages_from_pdf(path):
    from pypdf import PdfReader  # only the PDF mode needs pypdf
    return [page.extract_text() or '' for page in PdfReader(str(path)).pages]


def pages_from_text(path):
    return Path(path).read_text(encoding='utf-8').split('\f')


def heading_targets(semester, month, month_year, first, second, target):
    """Whether a section heading names the target year: its AY, and (when the
    heading gives one) the month's year, August of the first year for Sem 1 and
    January of the second for Sem 2."""
    t1, t2 = target
    if (first, second) != (t1, t2):
        return False
    expected_month = 'august' if semester == 1 else 'january'
    if month.lower() != expected_month:
        return False
    if month_year is not None:
        return month_year == (t1 if semester == 1 else t2)
    return True


def extract(pages, target):
    """Returns (updated, kept, dropped): kept maps semester -> set of codes for
    the target year's sections; dropped lists the headings of the others."""
    kept = {}
    dropped = []
    updated = None
    semester = None  # the current section's semester, None while outside a kept one
    in_section = False
    for text in pages:
        if updated is None:
            m = re.search(r'Updated as at (\d{1,2} \w{3} \d{4})', text)
            if m:
                updated = m.group(1)
        for line in text.split('\n'):
            section = SECTION_RE.search(line)
            if section:
                in_section = True
                sem = int(section.group(1))
                first, second = int(section.group(2)), int(section.group(3))
                month_year = int(section.group(5)) if section.group(5) else None
                if heading_targets(sem, section.group(4), month_year, first, second, target):
                    semester = sem
                    kept.setdefault(semester, set())
                else:
                    semester = None
                    dropped.append(section.group(0).strip())
                continue
            if not in_section or semester is None:
                continue
            # The repeated navigation header names both semesters; skip it so it
            # cannot be mistaken for data.
            if 'Page 1 to Page' in line or 'P a g e' in line:
                continue
            for code in CODE_RE.findall(line):
                kept[semester].add(code)
    return updated, kept, dropped


def published_from_manifest(year):
    path = ROOT / 'data' / f'ng-sources-{year}.json'
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding='utf-8'))
    return sorted(int(s) for s, on in data.get('published', {}).get('ngList', {}).items() if on is True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Extract the NG course list for one acad year.')
    ap.add_argument('pdf', nargs='?', help='the NG list PDF (omit with --from-text)')
    ap.add_argument('--year', required=True, help='the target acad year, YYYY-YYYY')
    ap.add_argument('--from-text', dest='from_text', help='text already extracted, pages separated by form feeds')
    ap.add_argument('--published', help="the published semesters, e.g. 1,2 (default: the year's source manifest)")
    ap.add_argument('--out', help='where to write (default data/ng-courses-<year>.json)')
    args = ap.parse_args(argv)

    m = YEAR_RE.match(args.year)
    if not m or int(m.group(2)) != int(m.group(1)) + 1:
        print(f'--year {args.year} is not an acad year (YYYY-YYYY)', file=sys.stderr)
        return 2
    target = (int(m.group(1)), int(m.group(2)))

    if args.published is not None:
        published = sorted({int(s) for s in args.published.split(',') if s.strip()})
    else:
        published = published_from_manifest(args.year)
        if published is None:
            print(f'no data/ng-sources-{args.year}.json to say which semesters are published; pass --published', file=sys.stderr)
            return 2

    if args.from_text:
        source = Path(args.from_text)
        pages = pages_from_text(source)
    else:
        if not args.pdf:
            print('give the PDF, or --from-text <file>', file=sys.stderr)
            return 2
        source = Path(args.pdf).expanduser()
        if not source.exists():
            print(f'No such file: {source}', file=sys.stderr)
            return 1
        pages = pages_from_pdf(source)

    updated, kept, dropped = extract(pages, target)

    for heading in dropped:
        print(f'dropped       {heading}  (not {args.year})')
    problems = []
    for s in published:
        if s not in kept:
            problems.append(f'Semester {s} is published (data/ng-sources-{args.year}.json) but the PDF has no section for it in {args.year}; the layout or the headings may have changed.')
    for s, codes in sorted(kept.items()):
        if not codes:
            problems.append(f'The Semester {s} section of {args.year} has no rows; the PDF layout may have changed.')
        if s not in published:
            problems.append(f'The PDF has a Semester {s} section for {args.year}, but the source manifest marks Semester {s} unpublished; publish it there first.')
    if problems:
        for p in problems:
            print(p, file=sys.stderr)
        return 1

    out = {
        'source': 'NUS Registrar, "Course Offered for Non-Graduating (NG) Students"',
        'sourceFile': 'ng-courses.pdf' if args.from_text else source.name,
        'updatedAsAt': updated,
        'acadYear': args.year,
        'semesters': {str(s): sorted(c) for s, c in sorted(kept.items())},
    }
    all_codes = sorted(set().union(*kept.values())) if kept else []
    out['allCodes'] = all_codes

    dest = Path(args.out) if args.out else ROOT / 'data' / f'ng-courses-{args.year}.json'
    dest.write_text(json.dumps(out, indent=2) + '\n')

    print(f'source        {source}')
    print(f'acad year     {args.year}   (updated as at {updated})')
    for s, codes in sorted(kept.items()):
        print(f'semester {s}    {len(codes)} distinct course codes')
    print(f'union         {len(all_codes)} distinct course codes')
    print(f'wrote         {dest}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
