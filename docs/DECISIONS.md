# Architecture decisions

Why Journeyman is built the way it is. Each entry records a decision that
would otherwise be re-litigated or silently undone, and what it cost to learn.

Format: context, decision, consequences. Newest last.

---

## 1. The engine is pure, and knows nothing about sport

**Context.** A game with phase timers, a claim race and a grace window is
mostly timing logic. Timing logic tested against a real clock is slow and
flaky, and tested against a running server is neither.

**Decision.** `src/engine/` takes the current time as an argument and the
dataset as `deps`. No I/O, no `Date.now()`, no imports of anything in
`data/`. Every exported mutator clones its input and returns new state.

**Consequences.** Every timing rule is tested without waiting: 164 tests run
in about a second. Three mutate-in-place bugs shipped during the first build
and were caught by review rather than tests, so there is now a test asserting
that no exported mutator touches what it was given — treat it as load-bearing.

The unplanned payoff: when a second sport was added, **the engine needed no
changes at all**. All five occurrences of the word "football" in `src/engine`
and `src/protocol.js` were comments. Adding basketball later cost four lines
across the whole codebase.

---

## 2. Sport is a room setting, not a deployment

**Context.** Hockey could have been a second container with a `SPORT` env
var, or a forked repo.

**Decision.** One server loads every available dataset and hands the engine
the right `deps` per room. Sport is a host-only lobby setting beside the round
count, locked once play starts.

**Consequences.** One URL, one codebase, one set of tests; a fix lands in all
three games at once. A missing dataset disables that sport rather than
stopping the server — losing one game is better than losing all three.

Locked at start because the club pool comes from the sport's own dataset:
switching mid-game would leave players holding teams that do not exist in the
dataset being scored against.

---

## 3. `src/protocol.js` is the only place that decides what a client may see

**Context.** Hidden information is the game. Picks are secret while choosing;
answers were secret until the reveal.

**Decision.** One function, `snapshotFor(state, playerId)`, builds everything
a client receives. Nothing else serialises state to a socket.

**Consequences.** "Can a rival see this?" has exactly one place to look, and
the answer is testable without a browser. Entity ids and timestamps never
leave the server at all — an id is a handle for guessing.

This is also why labels are resolved at *submit* time rather than at reveal:
`snapshotFor` has no `deps`, and giving it some would put dataset access
inside the module whose whole job is deciding what to withhold.

---

## 4. Claimed answers are public; club picks are not

**Context.** Both were hidden originally, on the same reasoning: seeing a
rival's move helps them.

**Decision.** Club picks stay hidden during PICKING. Claimed footballers are
published as they land.

**Consequences.** A name already claimed is *rejected*, so it was never
copyable — hiding it only made people waste their round discovering by trial
and error which names were gone, then get scolded by a banner. Picks are
different: seeing the grid fill up turns choosing into reacting.

When this changed, the test asserting answers are never disclosed **still
passed**, because the new field had a different name. It would have sat there
documenting a rule the game no longer had. Rewritten deliberately.

---

## 5. Clocks arm late, and only for the last player

**Context.** A flat countdown from the start of each phase rushed everyone,
including the six people still reading a grid of 97 clubs.

**Decision.** No visible clock until everyone *but one* has acted. Then that
player gets `pickSeconds` / `answerSeconds`. An unseen backstop
(`pickMaxSeconds`, `answerMaxSeconds`) stops an abandoned room hanging.

**Consequences.** The game feels unhurried until it should not. Two costs,
both accepted: a player who disconnects mid-pick stalls the round until the
60s backstop expires, and a *rejected* answer must not arm the clock — being
beaten to a name should not put the whole room on a countdown.

The backstop is withheld from the snapshot, or players would see a
60-second countdown that means nothing.

---

## 6. Collisions are settled at random, not by who tapped first

**Context.** Once picks are hidden, two players can want the same club with
no way to know.

**Decision.** Everyone may pick any club. At the end of the phase, one
colliding player keeps it — chosen at random — and the others are moved to a
free club and told plainly on the next screen.

**Consequences.** Speed decides nothing, because nobody could see the
collision coming; rewarding it would reward a faster phone. The round still
ends with one distinct club per player, which is what keeps the maximum score
equal to the player count. Both the early-advance path and the timeout path
must resolve collisions, or a round that ran out of time hands two players
the same club.

---

## 7. Football data is built in two passes, and the order matters

**Context.** Wikidata's P54 statements are the obvious source and are
quietly incomplete. João Félix had Chelsea and AC Milan — no Benfica, no
Atlético, no Barcelona — plus an entry for FCSB, a Romanian club, where the
Barcelona loan belongs.

**Decision.** `dataset` builds from Wikidata; `enrich` then adds career gaps
from Wikipedia infoboxes, which are hand-maintained by people who follow the
sport. Enrichment is **additive** — it never removes a club Wikidata asserts.

**Consequences.** 1,885 club links across 1,477 players that would otherwise
be missing.

Two sources disagreeing is not evidence about which is wrong, and a pass that
can delete is one that can quietly gut 52,000 players — hence additive only.
Every change is written to `data/enrich-report.json` so the diff can be read
before it is trusted.

**`dataset` rewrites the file from scratch and silently discards enrichment.**
This was discovered by checking one player on a hunch after a rebuild. Always
run `enrich` after `dataset`. The script now says so when it finishes.

---

## 8. Hockey and basketball come from the leagues themselves

**Context.** Wikidata covers both (861 players for Montreal under the same
P54 property), and hockeydb has broader coverage.

**Decision.** NHL public API for hockey; the endpoints behind nba.com for
basketball.

**Consequences.** The NHL publishes this itself — free, keyless, complete
back to 1917-18, with name, birth date and country already in the roster
entry. When the official source is both better *and* permitted, inferring
from a knowledge graph or scraping a third party is work for no reason.

The NBA publishes nothing as clean, but its endpoints answer to browser
headers and are complete. **A throttled request comes back as an HTML error
page with status 200**, not a 429 — code that trusts the status code parses
garbage. The builder treats the body shape as the signal.

NBA rosters carry no nationality, only a school, so basketball labels read
`L. James (1984)` where football reads `J. Félix (1999, PT)`.

---

## 9. Every long build caches per unit of work

**Context.** The Wikidata rebuild was all-or-nothing against a public
endpoint that throttles under sustained load. A failure at club 57 of 97
threw away everything before it.

**Decision.** Rosters cache per club (or per team-season) as they arrive. A
failed run resumes; a completed run clears the cache so the next deliberate
rebuild really refetches.

**Consequences.** A full football rebuild cost four attempts before this
existed and one after. The enrichment pass had already taught this lesson and
it was not carried across — that is the actual cost being recorded here.

Related: the query service truncates responses mid-JSON under load, which
surfaces as a `SyntaxError`. It is a "come back later" signal, not a
malformed response, and the same query succeeds alone minutes later.

---

## 10. No build step, hand-written CSS

**Context.** The game is played on phones over a Cloudflare quick tunnel.

**Decision.** Plain JS and hand-written CSS from the design system's own token
values. No bundler, no framework, no Tailwind CDN.

**Consequences.** First paint is ~38KB — one round trip, no render-blocking
JS. A Tailwind CDN build ships a compiler that runs on *every page load*,
which is the opposite of what this needs.

Measured cost of the tunnel: every request pays ~130-216ms regardless of
size. That is per-request latency, not bandwidth, and it is why crests are
lazy-loaded and cached for a month, and why the 97-card grid re-renders only
when *your own* pick changes.

---

## 11. Player and club ids are the source's own

**Context.** Crests are files named `Q7156.png`, `MTL.png`, `LAL.png`.

**Decision.** Club ids are Wikidata QIDs for football, and the league's own
abbreviations for hockey and basketball. Crests are joined by exact id —
Wikidata sitelink to Wikipedia article to lead image — never by name match.

**Consequences.** The join is deterministic and auditable; a contact sheet
exists so 97 crests can be eyeballed against their club names once.

A name-based join would have quietly produced Deportivo's reserve team, which
is what happened during club curation and was caught by scanning every entity
description for `reserve|women|youth|academy`.
