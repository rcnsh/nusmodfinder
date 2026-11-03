# Phase 1 probe — acad year 2026-2027

## Acad year availability
- 2024-2025: HTTP 200
- 2025-2026: HTTP 200
- 2026-2027: HTTP 200
- 2027-2028: HTTP 404

## Files
- moduleList.json: 6771 entries, 0.57 MB
- moduleInfo.json: 21130 records, 18.85 MB

## Per-module keys (union across all records)
- attributes, corequisite, department, description, faculty, gradingBasisDescription, moduleCode, moduleCredit, preclusion, prerequisite, semesterData, title, workload
- moduleCredit runtime type(s): string

## Corpus
- records in moduleInfo.json (whole catalogue): 21130
- offered this acad year (>=1 semesterData): 6771
- usable after title/description validation: 6771
- skipped for missing fields: 0
- offered codes absent from moduleList.json: 0

## Field shapes
- codes not matching /^[A-Z]{1,4}\d{4}[A-Z]{0,3}$/: 3 (DMA1401L01, DMR1201GEQA, LC6009GRSII)
- distinct faculties: 26
- longest faculty name: 33 bytes (metadata index limit is 64)
- semester values seen: 1, 2, 3, 4
- modules offered in >1 semester: 1974
- levels seen: 1, 2, 3, 4, 5, 6, 8
- credits range: 0 – 41

## Embedding blob
- model: @cf/baai/bge-small-en-v1.5 at 384 dims, 512 max input tokens
- blob chars max across corpus: 1900
- blobs truncated to the 1900-char cap: 14

## Free-plan budget (Vectorize)
- stored dimensions: 6771 x 384 = 2,600,064 of 5,000,000 (52.0%)
- queried dimensions billed as (queries + stored) x dims; free cap 30,000,000/month
- searches available per month: ~71,354

## Verdict: GO
