# Phase 5 red team: front-end security review (5G)

## Scope and method

**Scope.** All of `public/` (`index.html`, `app.js`, `state.js`, `nav.js`, `api.js`, `dom.js`, `render.js`, `detail.js`, `explain.js`, `format.js`, `messages.js`, `intents.js`, `intent-chips.js`, `icons.js`, `keys.js`), plus the Worker code the page relies on: `src/index.js` (routing, the 404 and 500 bodies), `src/http.js` (the JSON response headers), `src/modules.js` (`/module/:code` and `/facets`, `nusmodsUrl`), `src/search.js` `parseFilters` and `parseSearch` (what `/search` echoes), `src/ng-reasons.js` (`NG_SOURCES`), `data/ng-reasons.json` `sources`, `wrangler.jsonc` and `test/wrangler.ui.jsonc` (static assets, no `_headers`), and `eslint.config.mjs` (the HTML-sink ban).

**Method.** First a code review of every path from the URL, a `/search`, `/module` or `/facets` body, or an error to the DOM, an attribute, a link or history. Then local tests only: `npm run dev` (`scripts/ui-server.mjs`: the Worker with FakeAI over the fixture D1, `http://127.0.0.1:51467` for this run), driven by curl and by the Playwright scripts in `security/`, in Chromium and WebKit (Playwright 1.64.1). Each script refuses any URL except a local one, and its browser context aborts every request that isn't for the local server. Nothing went to `*.workers.dev` or any Cloudflare API. Ports 8787 and 8799 weren't touched. The server was stopped with SIGINT at the end.

| Script | What it does |
|---|---|
| `security/url-params.mjs <url>` | 21 crafted page URLs (markup, `javascript:`, prototype-pollution keys and values, repeated, malformed `%`, NUL and bidi controls, 5 000-char `q`, 6 000-char `faculty`, 2 000 `pick`, payloads in the hash) in Chromium and WebKit. For each it opens the first detail too, then checks: no payload ran, no dialog, no `img`/`script`/`iframe`/`object`/`embed`/`foreignObject`, no `on*` attribute, no `javascript:`/`data:` URL, every link either `/?…`/`#…` or `https:`, `noopener` on every `target=_blank`, `Object.prototype` clean, and the URL the page settled on. |
| `security/misleading-links.mjs <url> [shotdir]` | What a crafted link can make the page say: the `from=` kicker, echoed `q` and `faculty`, and `study=` against a saved year. |
| `security/headers.mjs <url>` | The security headers on the page, a script and every API route. Then, from a second origin (`http://localhost:<port>/__attacker`, answered by Playwright's router), it frames the page, sends input through the frame, and loads API JSON as `<script>` and as a stylesheet. |

## Findings

### F1. `from=` makes the page say two unrelated courses are "another code for the same course"

- **Severity: low.** A crafted link puts a false equivalence claim in the site's own voice in the detail head. Nothing runs, and the code and title beside it contradict the claim to anyone who knows the courses.
- **Where:** `public/state.js:98` keeps any code-shaped `from` beside a valid `open`. `public/app.js:314` passes it to the detail whenever the code is the open one. `public/detail.js:170-171` renders "Opened from X: another code for the same course". At no point does the page check that `from` is one of `open`'s variants.
- **Reproduction:** `node docs/evidence/phase5/redteam/security/misleading-links.mjs http://127.0.0.1:51467`, or open `http://127.0.0.1:51467/?q=PP5288&open=PP5288&from=CS1010`. Observed:
  ```
  kicker:   Opened from CS1010: another code for the same course
  heading:  PP5288 Labour Market Issues and Public Policy
  PP5288 variants per /search: []; /module title: Labour Market Issues and Public Policy
  settled URL keeps from=: true
  ```
  CS1010 is "Programming Methodology". PP5288 lists no variants.
- **Impact:** Exchange students map NUS courses to credit at their home university. A shared link can tell one of them that a course is the same course as another code (for example, one their home university already approved), and the page vouches for it. The canonicalised URL keeps `from=`, so the claim survives reload and re-sharing.
- **Fix:** Render the kicker only when `from` is among the `variants` of the open card's `/search` result (or the code's `/module` data). Otherwise drop `from` and `replaceState` the URL without it.

### F2. `q` and `faculty` from a link are echoed where the page's own sentences go, so they can read as site guidance

- **Severity: low.** This is text-only content spoofing on a crafted link. `q` is capped at 200 characters and shown inside quotes. `faculty` has no length cap and is shown unquoted as a filter chip, but any spoofed faculty empties the results.
- **Where:** `public/state.js:89` (`q`, capped at 200) and `public/state.js:93` (`faculty`, trimmed only). `public/render.js:371-375` puts the typed `q` in the count line and the live region. `public/messages.js:64,74` does the same for the no-match sentences. `public/app.js:244` uses `faculty` as a chip label, and `public/app.js:156-158,184` adds it as the selected `<option>`.
- **Reproduction:** Run the same script.
  - `http://127.0.0.1:51467/?q=accounting%E2%80%9D%20%E2%80%94%20NUS%20Registrar%3A%20every%20course%20below%20is%20open%20to%20all%20exchange%20students%20this%20year%2C%20no%20approval%20needed%20%E2%80%9C` gives:
    ```
    count: 20 courses match “accounting” — NUS Registrar: every course below is open to all exchange students this year, no approval needed “”
    live:  (the same sentence, said to screen readers)
    ```
  - `http://127.0.0.1:51467/?q=accounting&faculty=Verified%20by%20the%20NUS%20Registrar%3A%20all%20courses%20on%20this%20site%20are%20open%20to%20exchange%20students.%20You%20do%20not%20need%20to%20check%20with%20NUS.` gives a filter chip, and the Faculty select's chosen option, reading "Verified by the NUS Registrar: all courses on this site are open to exchange students. You do not need to check with NUS." The status says "No courses match “accounting”." The bidi override U+202E also survives into the chip (`url-params.mjs` case "NUL and controls"), so chip text can be shown reversed.
- **Impact:** A link can put a fake "NUS Registrar" statement directly above real results. That works against the "Check with NUS before you register" message the site relies on. Search answers almost any query, so the count line appears with results under it.
- **Fix:** Show `q` in the count line visually set apart (a `<q>`/mono span, truncated around 60 characters with an ellipsis), and strip bidi controls (U+202A-E, U+2066-9). Before rendering a `faculty` chip, accept only a value `/facets` lists (or cap it at about 60 characters until `/facets` answers).

### F3. The page can be framed by any site

- **Severity: low.** No `X-Frame-Options` or CSP `frame-ancestors` is sent. There's no login and no server-side state, so the only thing clickjacking can change is the year of study saved on the device. Still, that's the eligibility answer the site pre-fills.
- **Where:** No `public/_headers` exists. `wrangler.jsonc` `assets` sets no headers, and `src/http.js:8-12` sets only `content-type` and `access-control-allow-origin`.
- **Reproduction:** `node docs/evidence/phase5/redteam/security/headers.mjs http://127.0.0.1:51467`. Every route lists `content-security-policy=-`, `x-content-type-options=-` and `x-frame-options=-`. Then, from `http://localhost:51467/__attacker`, a near-transparent iframe of `/?q=accounting&ng=1&sem=1&study=ug1`:
  ```
  chromium: framed and rendered results: true; input through the frame: vnm.study null -> grad; frame URL ?q=accounting&sem=1&ng=1&study=grad
  webkit:   framed and rendered results: true; input through the frame: vnm.study null -> grad; frame URL ?q=accounting&sem=1&ng=1&study=grad
  ```
  The script turns off Chromium's Local Network Access check, which blocks any page from reaching loopback. The live site isn't on loopback, so that check doesn't protect it.
- **Impact:** An overlay page can trick a click into the framed year-of-study select. The change is saved to `localStorage` (`vnm.study`, `public/app.js:588`). Later visits pre-fill it on the first screen (`app.js:861`) and use it for any `ng=1` link without `study` (`app.js:853`). The student would see a "Graduate" chip and grad-only statuses (F4 shows what changes).
- **Fix:** Add `public/_headers` with `/*` → `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (also `X-Content-Type-Options: nosniff`). A fuller CSP needs a hash for the inline script at `index.html:17`.

### F4. A link's `study=` silently replaces the year the student saved

- **Severity: info.** This is by design ("the URL always wins", `app.js:143-144`) and visible as a chip. It's listed because it's the one way a crafted link makes the page show a real "Open" status for a course the student can't take.
- **Where:** `public/app.js:176,186` (the URL's `study` wins over `localStorage`), and `app.js:201` (any query string skips the first screen, which asks the year).
- **Reproduction:** Run `misleading-links.mjs` part 3 with `vnm.study=ug1` saved.
  ```
  /?q=PP5288&sem=1&ng=1&study=ug1   chips ["Sem 1","1st year","Exchange students"] | hidden: Not open in Sem 1 / … Undergraduates may not take Public Policy (PP) courses …
  /?q=PP5288&sem=1&ng=1&study=grad  chips ["Sem 1","Graduate","Exchange students"] | entry: Sem 1 · Open, with 2 notes
  set-up screen shown: false; saved year after: ug1; any notice that the link changed the year: false
  ```
- **Impact:** A 1st-year student opening a shared link made by a graduate (or crafted) sees PP5288 stamped Open. The only cue is the non-removable "Graduate" chip and, in the detail, "As a graduate exchange student". No status is fabricated, and nothing is saved.
- **Fix:** When the URL's `study` differs from the saved one, show a one-line notice, for example "This link is set for Graduate students; you saved 1st year. Use 1st year", with a button.

## Checked and found sound

- **No markup sink in the page.** `public/dom.js:17-23` builds elements and appends strings as Text nodes. Lint bans `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` by property, identifier and literal (`eslint.config.mjs`), and `npx eslint public/` passes. A grep of `public/*.js` finds no `eval`, `Function`, string `setTimeout`, `postMessage` listener, `location` assignment, `window.open`, `srcdoc`, `DOMParser` or attacker-fed `style`. The only `style` write is the header height (`app.js:776`).
- **Markup, `javascript:` and payloads in every URL parameter and the hash render as text.** `url-params.mjs` ran 21 cases × 2 engines and printed `all cases clean`: no payload ran, no injected element or `on*` attribute, and no off-origin request.
- **Attribute values only come from fixed names.** Every `attrs` key in `public/` is a literal. Values from data go only into `href` (built below), `data-*`, `aria-label` and `class` suffixes picked from fixed maps (`render.js:44,111`). `id`s are counters (`render.js:197-199`) or literals, so data can't create an `id` or `name`, and DOM clobbering isn't possible. Radio lookups use constant names (`app.js:137`).
- **Link targets.**
  - Course-code links are `urlFor(…, location.pathname)` → `/?…` (`app.js:290-292`, `render.js:87,101`). The path is always `/`: `/index.html` and `/fonts/../index.html` 307 to `/`, and `//evil.example/`, `/%2F%2Fevil.example/index.html`, `/\evil.example/index.html` and `/x/` all 404 (curl run). So `location.pathname` can't become protocol-relative.
  - The NUSMods link must start with `https://nusmods.com/` (`detail.js:166`), and the server builds it from a regex-checked code (`src/modules.js:50,196`).
  - Source links must match `^https://` (`detail.js:136`). They come from `data/ng-reasons.json` shipped with the Worker (`src/ng-reasons.js:33`), not from third-party data. Both point at `www.nus.edu.sg`.
  - Every `target=_blank` has `rel=noopener` (`detail.js:136,187`, `index.html:142-145`, and checked on every page state in `url-params.mjs`). With no `Referrer-Policy`, browsers default to `strict-origin-when-cross-origin`, so NUSMods and NUS get the origin only, not the query.
- **No open redirect.** The page navigates only through `pushState`/`replaceState` with same-origin relative URLs (`app.js:553-554,856`) and same-origin `<a>`s. The Worker emits no `Location` anywhere (`src/` grep), and the asset layer's only redirects go to `/` (curl above).
- **URL-state handling** (`state.js:81-102`):
  - `sem`, `level`, `credits`, `study` and `ignore` are allow-listed.
  - `open` and `from` must be code-shaped (`from` only beside `open`).
  - `q` is capped at 200 (the 5 000-char case settled at 203 bytes of query).
  - Repeated params take the first (`?q=accounting&q=biology&sem=1&sem=2…` settled to `q=accounting&sem=1`).
  - Malformed `%` decodes to U+FFFD or literal text without an exception.
  - `pick`/`alt` are carried through but never rendered (2 000 `pick`s round-trip, nothing shown).
  - Exchange mode with a bad `study` drops it and asks for the year.
  - The hash is dropped on canonicalisation (`app.js:855-856`).
- **No prototype pollution.** URL state is read key-by-key from `URLSearchParams`, with no merging of parsed objects. `__proto__[x]=`, `constructor[prototype][x]=` and `__proto__` values leave `Object.prototype` clean (`url-params.mjs` "proto" cases). Lookups by server-supplied keys use `Object.hasOwn` (`messages.js:45,73`), fixed maps with fallbacks (`render.js:110`, `explain.js:28,85`), or values `state.js` already allow-listed.
- **Server error text never reaches the page.** `api.js:63-65` keeps only the `error` code, and `messages.js:41-46` maps it to a fixed sentence. `/module/%3Cx%3E` → 400 `"\"<X>\" is not a module code."` is JSON only. Non-JSON bodies become `not_json` (`api.js:54`).
- **Missing `X-Content-Type-Options` doesn't let API JSON run.** In `headers.mjs`, Chromium refuses `/search` and `/module` as a cross-origin script and as a stylesheet (`search:error`, `module400:error`, `css:error`). WebKit loads `/search` as a script (`search:load`), but the body is always `JSON.stringify(…, null, 2)` beginning `{\n  "query": `, which is a syntax error as script, and WebKit refuses it as CSS ("non CSS MIME types are not allowed in strict mode"). `access-control-allow-origin: *` exposes only public catalogue data. There are no cookies or credentials.
- **No CSP.** No injection was found, so there's nothing a CSP would stop here today. Its value would be defence in depth (see F3's fix for the inline-script hash).

Not reproducible locally, so not reported: the phrase chips and `ignore=` path (`PARSE_PHRASES` is off on the UI stack, so `/search` echoes no intents).
