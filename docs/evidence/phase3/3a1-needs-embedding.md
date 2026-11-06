# 3A-1: query texts that need a real embedding

3A-1 embeds `Represent this sentence for searching relevant passages: ` + the canonical query (`QUERY_INSTRUCTION` in
`src/embedding.js`, `denseSearch` in `src/search.js`). The committed query caches hold the raw
and canonical forms only, so every query needs one new vector: the instruction + its canonical form.
Each vector is keyed by `sha256(model + "\n" + text)` with model `@cf/baai/bge-small-en-v1.5`,
in the `vnm-eval-embeddings/1` cache format. The lists below give each **canonical query**; the text to
embed is the instruction followed by it, with nothing between them but the instruction's own
trailing space. No Workers AI call was made for this list.

| cache | read by | new texts |
|---|---|---|
| `eval/fixtures/embeddings.json` | `npm run test:eval` (CI `check` job) | 10 |
| `eval/dev/embeddings.json` | `npm run eval` on dev (the dev screen; not CI) | 98 |
| `test/sc4/embeddings.json` | not yet read with the prefix by any test or CI job (see below) | 143 |
| holdout cache (encrypted) | the custodian's L1 look | not listed: custodian only |
| **total listed** | | **251** |

How to add them (lead, local):
- fixture and dev: `npm run eval:embed -- --set fixture` and `npm run eval:embed`. `scripts/embed.mjs`
  now embeds every form `queryTextForms(text, QUERY_INSTRUCTION)` gives, so it picks up exactly
  these texts and nothing already cached.
- holdout: `npm run eval:embed -- --set holdout` (custodian), the same way.
- SC4: `embed.mjs` has no SC4 set; put the prefixed texts in a `{ "texts": [...] }` file and run
  `npm run eval:embed -- --texts <file> --out test/sc4/embeddings.json`.

The four dev texts SC4 names (d-016, d-022, d-024, d-079) are in the dev list, not the SC4 list,
as their unprefixed forms are in the dev cache today.

## `eval/fixtures/embeddings.json`: 10 texts

The fixture set has 11 queries; two of them are `machine learning`, so they share one text.
This cache was embedded by real Workers AI (`npm run eval:embed -- --set fixture`), not by a fake,
so it is not regenerated here.

```text
learn to program from scratch
cs1010s
machine learning
qwrtzp vbnmx
startup internship
korean langauge for beginners
modules with no final exam
xyz9999
introduction to psychology: this course surveys the scientific study of behaviour and mental processes, covering perception, learning, memory, motivation, emotion, personality, development and social psychology, with weekly seminars.
management courses in special term
```

## `eval/dev/embeddings.json`: 98 texts

```text
corporate finance valuation
brand management and consumer behaviour
is there a course on competitive strategy, like porter five forces, business models etc
corporate finance ii
international marketing: students learn to analyse international markets and develop marketing strategies for entering and operating in foreign markets. topics include market entry modes (export, licensing, joint ventures, fdi), cultural differences and their influence on consumer behaviour, standardisation vs adaptation of the marketing mix, global branding, and international pricing and distribution. case studies of multinational companies.
backup option if i don't get the investment course, something else in finance at similar level
japanese 1
marketing courses third year level bachelor
ib courses
advanced financial modelling excel
intro accounting no prerequisites
german tax law hgb bilanzierung
corprate fiannce iii sdf
human computer interaction user interface design
computer vision
cs 4400 operating systems
need an equivalent for my home course intro to ai. description: covers search (a*, minimax), constraint satisfaction, logic and knowledge representation, probabilistic reasoning and bayesian networks, intro to machine learning, and a final project implementing an agent. prereqs: data structures, discrete math, probability. learning outcomes: students can formulate problems as search, implement basic probabilistic inference, and evaluate ai systems.
what's similar to the machine learning course if it's full? exchange students never get the popular ones
upper-division cs course, 3 credit equivalent
how many nus units is equal to 3 us credits? i need 16 units total, 4 courses
hci / ux
general education course that's easy and interesting
intro course, no prerequisites, any subject
no final exam, project based cs course
asdkj qwpo cs44xx zzz
thermodynamics for mechanical engineering
fluid mechanics
machine design course gears bearings shafts
heat transfer conduction convection radiation
manufacturing process machining casting welding
thermodynamics 2
this course covers the basic concept of fluid mechanics including fluid properties, hydrostatics, conservation of mass momentum and energy, bernoulli equation, dimensional analysis and similitude, viscous flow in pipes and introduction to boundary layer. students will be able to analyze simple fluid systems used in mechanical engineering.
mechanical engineering design (capstone design 1) - team design project, concept generation, cad modeling, prototype and presentation
can exchange student take japanese 1
singapore history and society course
3 credit 2nd year mechanical course how many units in nus
engineering elective without final exam, project based
colonial history of southeast asia
history of migration and diaspora
gender and politics
introduction to comparative politics
this course examines the political and social history of twentieth century australia, including federation, the world wars, immigration policy, indigenous rights and australia's changing relationship with asia. students will analyse primary sources, develop skills in historical argument, and write a major research essay. by the end of the course students should be able to critically evaluate competing interpretations of national identity.
singapore history
singapore society, multiculturalism, race and religion
which courses count as third year level / upper-division, my uni needs 3000-level equivalent
sea studies
general education course on society or culture, interesting and easy
intro history course no prerequisites
no final exam, essay only assessment history
politics courses with no exam
dentistry clinical placement year 3
molecular biology
biochemistry metabolism enzymes
lab course molecular techniques pcr cloning gel electrophoresis western blot
is there something on marine biology or coral reefs
cell signalling pathways and cancer
microbiology bacteria
travaux pratiques biochimie: protein purification, enzyme kinetics, sds-page, spectrophotometry, chromatography
backup if i dont get the molecular biology module - something similar like genetics or genomics, preferably with lab
conservation of tropical rainforests and mangroves in southeast asia
evo devo
general education courses open to exchange students sem 2
advanced molecular biology 4000 level
biochemistry suitable for 3rd year students, not first year basics
veterinary medicine clinical rotation large animals
concurrent and parallel programming threads locks
software engineering design patterns object oriented design
philosophy of mind
ethics - moral philosophy intro
introductory economics microeconomics
secure software development, web vulnerabilities, how do i learn to find bugs in code
concurrent programming
need equivalent of our 'databases and data management' (relational model, sql, normalisation, transactions, intro to nosql)
similar to a computer security course but less oversubscribed
other options besides the main data engineering course, maybe databases or cloud
os
db sys + sql
general education course that is easy to fit with cs
ge module about technology and society
no prerequisites intro philosophy
computer science courses with no final exam, 100% coursework or project
bn4207
ll4541v
mle2105
ma2101
ee4502
cn 2109
cs 2030
is 4246
mul21
dao17
gec
advanced molecuular bioogy 4000 level
singapore society, multiculturalism, race and reliion
microbbiology bacteia
introducttory economics microoeconomics
machine desgin course gears bearings shafts
intro accunting no prerqeuisites
```

## `test/sc4/embeddings.json`: 143 texts

The 143 texts of `test/sc4/needs-embedding.txt` (P-6 suite texts, typo clean forms, constraint
references and the gibberish set), each prefixed. `test/sc4/embeddings.node.test.js` checks the
unprefixed forms only, so it passes without these; they are needed when the SC4 suite runs a
3A-1 ranker.

```text
cs 1010s
ma 1521
cs1010 s
ee 2211
lsm 1301
gea1000
es1000
cs 3000
cs2040 or cs2030
cs1231 s/u
cs32
cs101
cs 32
gea
gess
gex
cs32 machine learning
pl32 psychology lab
something like acc1701x for engineers
psycholgy of learning and memory
psychology of learning and memory
enviromental policy and sustainabilty
environmental policy and sustainability
orgainc chemistry reactions
organic chemistry reactions
introductry statistics
introductory statistics
marketting strategy for startups
marketing strategy for startups
introductory machine learning
programming for beginners
first year chemistry
economics with no background
graduate machine learning theory
masters level corporate finance
4000 level marketing
level 3000 econometrics
lvl 3000 urban planning
software engineering electives for 3rd year
2nd year data analytics
third year organic synthesis
project based cs course
sociology module without final exam
sociology module
no finals creative writing
creative writing
s/u-able chemistry module
chemistry module
pass/fail art modules
art modules
su-able statistics
statistics
light workload history elective
history elective
philosophy under 8 hours
philosophy
low workload music module
music module
no prerequisites calculus
calculus
no prereq data visualisation
data visualisation
linguistics no prerequisite
linguistics
asdfgh
lmao idk
skibidi
xqzv 4412
frobnicate quux
cs9999
lsm 9876
acc9123
geq1000
geh1001
art history
law and society
intro to psych
learn korean
ai
ai ethics
js
pr
dsa
comp 1010
math 1001
econ 1101
advanced calculus
not first year basics
give me 2 easy electives
how many units is 3 us credits
show me 4000 level courses
give me 3000 level electives
what is 2000 level
is it 3000 level
ee 2211 workload
it
it security
psychology electives for cs majors
final year project
philosophy for lsm students
se asia history
non graduate data science
beyond first year calculus
qwertyuiop
zxcvbnm
jkl jkl jkl
hjkl hjkl
aaaaaaaa
sdfsdf ghjghj
qazwsx
plmokn
lkjhgf poiuy
kxcd vvbn
lol
uhh hmm
ummm
hehe
idk tbh
brb afk
smh fr
pfft meh
oof ouch
mmmmm
rizz
yeet
gyatt
bussin fr fr
ong bestie
sheesh
mewing
delulu
kekw
zzkx qq
k9x 77qz
zq3 vv7
xj9k 2kq
h4x0r
b0rk b0rk
qw3rty
zz9 xx8
pqz 8812 wvx
blorp fizzwick
wug wugs
```
