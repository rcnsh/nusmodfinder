# 0018: Course review scores from NUSMods comments

Status: accepted. Adds to each result card; the data is described in [docs/data.md](../data.md),
the card in [docs/page.md](../page.md).

## Decision
- **Each card shows what students say about the course**, from the comments under it on NUSMods
  (its Disqus forum): an overall score out of 5 with a word ("Well liked" to "Strongly
  disliked"), a five-segment meter each for workload, difficulty and teaching, how many reviews
  and the latest academic year one is about, and a link to read them on NUSMods. It sits in the
  card's right-hand column, which is empty for an NUS student; in exchange mode it sits under the
  exchange status.
- **A card shows nothing under three reviews.** One or two reviews make a score that misleads,
  and a "too few to rate" box on most cards was clutter.
- **Claude Haiku 5.5 rates each comment** with structured output: whether it is a review (a
  writer's own account, not a question, reply or hearsay), the semester taken, and 1-5 scores for
  workload, difficulty, teaching and overall, each null where the comment doesn't say. One call
  per course thread, in chunks of 100 comments.
- **A course's numbers are means weighted by age**: a review's weight halves every three academic
  years before the current one, so a course that changed lecturer or assessment moves with its
  recent reviews. A review posted twice (the same opening) counts once, and the count on the card
  is of reviews with an overall score, the number it leads with.
- **Only the numbers are kept in the repo** (`data/reviews.json`); comment text stays in `.data/`
  and the card links to NUSMods for the reviews themselves.
- **Display only.** Nothing in search, filtering or ranking reads the scores; `/search` returns
  them as each result's `reviews`.

## Why
Students pick courses on what other students say, and NUSMods' comment threads are where they
say it, but reading 50 comments per course doesn't scale across a search's results. A plain
positive/negative sentiment model was considered and dropped: threads mix reviews with questions
and replies, course reviews are mixed by nature ("brutal workload, best prof, take it"), and an
average of those reads as "neutral" everywhere. Structured ratings per comment keep the parts a
student weighs separately.

Haiku over Opus: on 419 comments across 12 courses, Haiku's overall score matched Claude Opus
5.5's exactly on 81% of reviews and within one point on all, and per course within 0.3, at about
1/40 of the cost (the whole forum, about 9,900 comments, cost $2.73). An earlier "would
recommend" field was dropped: Haiku read recommendations into reviews that never made one.

## Consequences
- `npm run reviews -- crawl`, `score` and `build` rebuild the file (docs/data.md, "Course
  reviews"); crawl and score write run records. The scores come from one crawl and move only when
  someone reruns it, so they age: the card's "latest AYxx/yy" says how recent they are.
- The Worker bundles `data/reviews.json` (about 180 KB, one line per course).
- Reviews are self-selected and lean to strong opinions; the panel shows the count beside the
  score so a student can weigh it.
