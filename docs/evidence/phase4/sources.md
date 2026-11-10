# Phase 4 sources

The documents exchange mode's rules come from. nus.edu.sg and ystmusic.nus.edu.sg block
scripted downloads, so Jacob saves most of them by hand. Copies are kept outside the repo in
`~/.config/vnm/sources/<date>/`; this file records their hashes.
`scripts/build-ng-restrictions.mjs` refuses to build if any file it reads has a different hash or
any listed file goes unread, and writes the hashes it computed into the rules file.

## 2026-11-10

| file | source | updated as at | sha256 |
|---|---|---|---|
| `ng-courses.pdf` | Registrar, courses offered to NG students (non-graduating page) | 01 Sep 2026 | `4e0281bea179dab976982d4ef14fe24d1436ddd5966786074ff4eb8f792e89a4` |
| `non-graduating-course-restrictions.pdf` | Registrar, course restrictions for NG students | 31 Aug 2026 | `362ba277d12825b4fa9cbde86bcaad1dabf75a74c91b4d4dcaeba37f71c43b92` |
| `self-funded-graduate-courses.pdf` | Registrar, self-funded programmes (restrictions §A link; fetched directly) | 21 Aug 2025 | `1fbbd95fa0e3b102894a81a1c76c644d0788149404b42f9618279f9d03b9a0ad` |
| `yst-sem1-non-music-majors.html` | YST, AY2026/27 Sem 1 courses for NUS non-music majors (restrictions §6 "listed HERE"; that link is dead, and YST's electives page now points here) | AY2026/27 Sem 1 | `df8910b35487644e4260b1785c2c9cb0d9e0c15ae3e4e3cc723f273bba573aa8` |
| `yst-sem2-non-music-majors.html` | YST, Sem 2 courses for NUS non-music majors | **AY2025/26** Sem 2 (YST hasn't published AY2026/27 Sem 2) | `6361e644c38b7cf2d25b39220f9ee6f851d1419c920890d46886566c4f804e92` |
| `law-compulsory-llb-courses.png` | NUS Law course listing, compulsory LLB courses (restrictions §5 "See HERE"; screenshot by Jacob, page footer "last modified 02 August 2010" but lists current courses such as LC2017) | — | `18a29537cca99f8d91525c9f2ab59378d9808213553e243816800221d26e1249` |

The builder reads three text extractions; they are hashed too, so a changed extraction fails the
build like a changed original:

| file | source | updated as at | sha256 |
|---|---|---|---|
| `self-funded-graduate-courses.txt` | `pdftotext -layout` of the self-funded PDF | — | `6aebe6ed9bac3e8cd8ed5001e5dd7e7b25d455b15717eff4c256fae0bb8c78d1` |
| `yst-sem1-non-music-majors.txt` | text of the Sem 1 HTML (tags stripped, one text node per line) | — | `8e03268929993e263b0534d18e0e3bd556863cf0f87d3f63e7bc2142e9112207` |
| `yst-sem2-non-music-majors.txt` | text of the Sem 2 HTML | — | `7b63f960ca5b94245288b70c7e808755b39837b22ff5a93d8fd480478cd02f65` |

## What each one changes this year
- **NG list** re-extracts byte-identical to `data/ng-courses-2026-2027.json`.
- **Law list:** 48 compulsory LC-coded courses, none on the NG list; all 91 Law courses on the
  NG list are LL4 electives. No effect this year.
- **YST lists (whitelist for non-partner students):** 14 of the 16 MU-coded NG courses are listed
  for their NG semester. MUA3213 and MUA4161 are not, so they are `note-partner`. MUA3224 and
  MUT3222 need an audition or placement test (`note-audition`). Sem 2 uses last year's list
  until YST publishes AY2026/27 Sem 2; a refresh repeats the gate (plan 4F).
- **Self-funded list** (rule A, closed to every NG student): 2,451 codes, 6 of them on the NG
  list: CM5244, PC5202, PC5206, PC5211, LI5202, LI5204. CM5244 and LI5202/4 were already closed
  by Jacob's answers. PC5202/5206/5211 were open for graduates under Q1c (Physics omits them from
  its closed list); rule A is an explicit closure, so under Jacob's Q1a principle they are
  closed for every study level. This explains the omission: Physics had no need to list them.
