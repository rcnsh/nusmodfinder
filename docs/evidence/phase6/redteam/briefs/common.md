## The site
"NUS Mod Finder" (unofficial) is a website for students coming to the National University of
Singapore (NUS) on exchange. It is meant to tell you which NUS courses you may take on exchange
and on what conditions, and to let you keep a shortlist of courses and export it. You are trying
it as a real exchange student would, to plan your courses. It is live on the internet; you reach
it only through your browser below.

## Your browser
Your browser is already open. You control it only with:

    node K/act.mjs <command> [arguments…]

(K is the folder named at the top of this brief.) Each call does one thing and prints the
result. Start with `node K/act.mjs goto /` to open the site's home page. Your commands are
listed in "How you use the site" below; any other command is refused.

- Run one command at a time, and wait for it. The site is slow on purpose (the browser spaces
  its requests out), so a command can take 10–90 seconds. Never run commands in parallel or in
  the background.
- Your browser has a request allowance. Don't waste it: no repeated reloads, no scripted
  loops over many searches. A real student's session is a few dozen searches and course
  pages at most.
- If something on the page is an error, read what it says and act as a student would (wait
  and try again once, or try something else).
- When the page downloads a file, or you print or save as PDF, the browser saves the file in
  `K/<your id>/downloads/` and tells you its name. When the page copies something to your
  clipboard, the browser also writes it to `K/<your id>/clipboard.txt`. You may open those
  files to check them.

## Rules
- Use only the site, through act.mjs. Read nothing else on this computer except the files your
  browser saves for you (above): no other files or folders, no source code, no other websites,
  no web searches. Everything you decide must come from what the site tells you and from your
  own situation in this brief.
- Put any notes you want to keep in `K/<your id>/notes.md`. Write your answers where step 4
  says. Touch no other file.

## What to do
1. Set the site up for your exchange as it asks, then search for courses for your plan below,
   in your own words, as you would.
2. Pick the courses your plan asks for, and any your plan says you must check. Open each one to
   see everything the site says about it. Build your shortlist on the site as your plan says.
3. For **every course on your final shortlist (picks and backups), and every course your plan
   says to check**, decide from what the site tells you, and your situation in this brief,
   whether you can take it, as one of:
   - **yes**: you can take it, and nothing the site mentions stands in your way;
   - **yes if <condition>**: you can take it if something that isn't settled yet works out
     (write the condition in your own words);
   - **no**: you can't take it;
   - **ask NUS**: the site doesn't let you tell; you would have to ask NUS.

   If the site names a condition and your situation below already settles it (you meet it, or
   you don't), don't write "yes if": answer yes or no as your situation decides. Use "yes if"
   only for what is still open (for example something someone else has yet to decide). If the
   site says it can't tell and to check with NUS or a department (for example whether the
   course runs, or whether a rule applies to you), answer "ask NUS".
4. Write `K/<your id>/answers.json`: a JSON array, one entry per course and semester, no
   duplicates:

       {"code": "AB1234", "sem": 1, "list": "pick|backup|checked", "answer": "yes if …", "page_said": "<what the site said that decided it, quoted where you can>", "where": "<where on the site you found it>", "confidence": "high|medium|low"}

   `answer` is exactly `yes`, `no`, `ask NUS`, or starts with `yes if `. `list` says whether the
   course is a pick or a backup on your final shortlist, or one you only checked.
5. Reply with: your searches (in order), your final shortlist in its order and your answer for
   each course, what your plan below asks you to report, and anything on the site that confused
   you, misled you, blocked you, or that you couldn't do the way your situation required. Be
   specific: what you did, what you expected, what the site did. Name anything you think is
   wrong on the site.
