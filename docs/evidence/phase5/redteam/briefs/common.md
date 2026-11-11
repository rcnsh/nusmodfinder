## The site
"Exchange Course Finder (unofficial, for NUS)" is a website for students coming to the National
University of Singapore (NUS) on exchange in academic year 2026/27. It is meant to tell you
which NUS courses you may take on exchange and on what conditions. You are trying it as a real
exchange student would, to plan your courses. It is live on the internet; you reach it only
through your browser below.

## Your browser
Your browser is already open. You control it only with:

    node K/act.mjs <command> [arguments…]

(K is the folder named at the top of this brief.) Each call does one thing and prints the
result. Start with `node K/act.mjs goto /` to open the site's home page. Your commands are
listed in "How you use the site" below; any other command is refused.

- Run one command at a time, and wait for it. The site is slow on purpose (the browser spaces
  its requests out), so a command can take 10–60 seconds. Never run commands in parallel or in
  the background.
- Your browser has a request allowance. Don't waste it: no repeated reloads, no scripted
  loops over many searches. A real student's session is a few dozen searches and course
  pages at most.
- If something on the page is an error, read what it says and act as a student would (wait
  and try again once, or try something else).

## Rules
- Use only the site, through act.mjs. Read nothing else on this computer: no other files or
  folders, no source code, no other websites, no web searches. Everything you decide must come
  from what the site tells you and from your own situation in this brief.
- Put any notes you want to keep in `K/<your id>/notes.md`. Write your answers where step 4
  says. Touch no other file.

## What to do
1. Set the site up for your exchange as it asks, then search for courses for your plan below,
   in your own words, as you would.
2. Pick the courses you would actually put on your plan (the number your plan asks for), and
   any your plan says you must check. Open each one to see everything the site says about it.
3. For **every course you pick or must check**, decide from what the site tells you, and your
   situation in this brief, whether you can take it, as one of:
   - **yes**: you can take it, and nothing the site mentions stands in your way;
   - **yes if <condition>**: you can take it if something that isn't settled yet works out
     (write the condition in your own words);
   - **no**: you can't take it;
   - **ask NUS**: the site doesn't let you tell; you would have to ask NUS.

   If the site names a condition and your situation below already settles it (you meet it, or
   you don't), don't write "yes if": answer yes or no as your situation decides. Use "yes if"
   only for what is still open (for example something someone else has yet to decide).
4. Write `K/<your id>/answers.json`: a JSON array, one entry per course (per semester, if your
   plan has two semesters), no duplicates:

       {"code": "AB1234", "sem": 1, "answer": "yes if …", "page_said": "<what the site said that decided it, quoted where you can>", "where": "<where on the site you found it>", "confidence": "high|medium|low"}

   `answer` is exactly `yes`, `no`, `ask NUS`, or starts with `yes if `.
5. Reply with: your searches (in order), the courses you picked and your answer for each, and
   anything on the site that confused you, misled you, blocked you, or that you couldn't do
   the way your situation required. Be specific: what you did, what you expected, what the
   site did. Name anything you think is wrong on the site.
