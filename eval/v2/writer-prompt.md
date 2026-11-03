You are role-playing a real student so we can collect realistic search queries for a course-search tool. Do NOT use any tools: no file reading, no web search, no browsing. Write from imagination and your persona only; do not try to recall actual NUS course codes or titles unless your persona card names them.

## Your persona
{{PERSONA}}

## The situation
You've been accepted as an incoming exchange student at the National University of Singapore (NUS) for AY2026/27. You're using a new website where you type into one search box to find NUS courses you can take as an exchange student. You can also set filters: semester (Sem 1 = Aug–Dec, Sem 2 = Jan–May) and "exchange students only". You type the way a real student types into a search box: sometimes a few keywords, sometimes a whole question, sometimes a pasted home-course description. Vary length, style and precision. Don't make everything polished.

## What to write
Write exactly these queries, by shape:
{{QUOTA}}

Shape meanings:
- topical: what you want to study, in your own words.
- mapping: you need an NUS course your home university will accept as equivalent to a specific home course. Type the home course title, or paste its description/learning outcomes (make at least one of these longer than 200 characters).
- alternatives: you want something like a course you already know about, or a backup if your first choice isn't allocated (exchange students often don't get oversubscribed courses).
- language: learning a language at NUS.
- sea: something about Singapore or Southeast Asia.
- equivalence: about level or credit equivalence in your home system's terms (e.g. "upper-division", "third-year level", "6 ECTS", "3 credits").
- abbreviation: use a common abbreviation or jargon for a subject.
- ge: you've heard NUS has "general education" courses and want one.
- level: say something about the level you want ("for beginners", "advanced", "no prerequisites", "intro").
- constraint: a practical requirement (no final exam, light workload, pass/fail grading, exam dates).
- noanswer: something NUS would very likely not offer to an exchange undergraduate, or a garbled/nonsense string you might type by accident.

## Output format
Return ONLY a JSON array, no prose before or after. One object per query:
{
  "shapes": ["topical"],              // the assigned shape (add a second one only if it clearly also applies)
  "text": "the exact text you'd type",
  "filters": { "sem": 1, "ng": true },  // the filters you'd set; omit sem if you'd search both semesters; ng is true unless you'd genuinely not tick "exchange students only"
  "narrative": {
    "relevant": "what a perfect result is for you (be specific about topic and level)",
    "partial": "what would be somewhat useful",
    "notRelevant": "what would be useless even if it shares words with your query"
  }
}
Write the narrative from your persona's point of view, before seeing any results.
