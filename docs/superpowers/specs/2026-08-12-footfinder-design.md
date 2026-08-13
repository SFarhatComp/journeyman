# FootFinder — design spec

**Date:** 2026-08-12
**Status:** approved for planning

A multiplayer football trivia game. Players join a private room, each claims a
club, then races to name a footballer whose career covers as many of those
clubs as possible.

## The game

Round structure, repeated for a fixed number of rounds:

1. **Picking (15s).** Every player picks one club from a curated list. A club
   taken by one player greys out for everyone else, so N players always
   produce N distinct clubs.
2. **Answering (30s).** Every player names one footballer via autocomplete. A
   footballer can be claimed by only one player per round — first submission
   wins.
3. **Reveal (8s).** Each answer is shown with the clubs it matched and the
   points scored, plus the best possible answer for that round.

**Scoring:** `points = |clubs the named footballer played for ∩ the round's
chosen clubs|`. Naming someone who played for three of the five clubs in play
scores 3. Round maximum equals the player count, since clubs are distinct.

After the final round, a scoreboard.

### Rules decided

| Rule | Decision |
|---|---|
| Duplicate club picks | Not possible — taken clubs lock out |
| Duplicate footballers | First to submit claims them |
| Rejected claim | Told immediately, granted 5s personal grace |
| No club picked in time | Auto-assign a random remaining club |
| No answer submitted | Zero points |
| Game end | Fixed round count, set at room creation (default 8) |
| Phase ends early | As soon as every connected player has acted |
| Players per room | 2 minimum, 8 maximum |

A phase that ends the moment everyone has acted matters more than it sounds:
without it, a room of fast players sits watching a dead countdown for 20
seconds every single round. The grace window is the one exception — if a player
is mid-grace after a rejected claim, the phase waits for them.

Auto-assigning a club on timeout rather than dropping the player keeps the
round's club count equal to the player count, so the maximum score stays
predictable and the round stays winnable.

## Audience and deployment

Private games among friends, each on their own phone. No accounts, no public
room discovery, no moderation. A nickname and a 6-character room code are the
only identity.

Runs as a single Docker container on the developer's machine, bound to
`127.0.0.1`, exposed to friends through a Cloudflare quick tunnel. The tunnel
is outbound-only: no router ports are opened and the home IP is never exposed.
The app is tunnel-agnostic — it serves HTTP on localhost and neither knows nor
cares how it is reached.

## Architecture

One container, one Node process, no database.

```
engine/       pure game logic — no I/O, no sockets, fully unit-testable
  room.js       state machine: LOBBY → PICKING → ANSWERING → REVEAL → FINAL
  scoring.js    score(playerId, roundClubIds) → points
data/
  dataset.json  baked into the image at build time
  index.js      load + autocomplete index
server.js     Fastify: static files + WebSocket. A thin shell over the engine.
public/       the UI (designed in Google Stitch, wired up here)
scripts/
  build-dataset.mjs   Wikidata → dataset.json
```

The engine never imports the transport layer. Every rule — the claim race, the
grace window, timeout auto-assignment — is a pure function over a state object,
so it can be tested without opening a connection.

### Why no database

The dataset is a few megabytes and read-only; it loads into a Map at boot. Room
state is ephemeral — a finished game is disposable, and an in-progress game
lasts minutes. A restart drops live games, which is acceptable at this scale and
recoverable with one `docker restart`.

## Data

### Source

Wikidata, via its public SPARQL endpoint. CC0, no key, no scraping, no terms-of-
service risk. Verified during design: it returns complete club histories with
start and end dates.

The extraction runs at **build time only**. The game never calls Wikidata at
runtime, so upstream latency or downtime can never affect a round.

`build-dataset.mjs` is the sole adapter between Wikidata's shape and the game's
shape. Swapping to a Transfermarkt-derived dataset later means rewriting that
one script, not the engine.

### Shape

```json
{
  "clubs":   [{ "id": "Q81888", "name": "AFC Ajax", "country": "NL" }],
  "players": [{ "id": "Q46896", "name": "Zlatan Ibrahimović",
                "birthYear": 1981, "clubIds": ["Q81888", "Q1422", ...] }]
}
```

`clubIds` contains **only clubs from the curated list**. This is load-bearing:
scoring becomes a set intersection, and the game never has to decide whether an
arbitrary team counts as a club.

That matters because Wikidata's club typing is unreliable. Verified during
design: FC Barcelona is *not* typed as `association football club (Q476028)` —
it is typed `representation team` and `professional sports team`. Filtering on
the obvious type would silently drop Barcelona. Restricting to a hand-curated
list of club QIDs sidesteps the problem entirely and excludes national teams
for free.

### Club list

Roughly 100 big European clubs — the big five leagues plus Ajax, Porto,
Benfica, Celtic and similar. Chosen because it is where Wikidata's coverage is
strongest and where nearly every combination has a findable journeyman.

Curated by hand as `clubs.json`, keyed by QID. Widening the list later is a data
change, not a code change.

### Scale

~100 clubs, roughly 25k players. A few megabytes in memory.

## Autocomplete and disambiguation

Players are selected from a dropdown, never free text, so scoring is
unambiguous.

**The dropdown must never reveal a player's clubs.** Doing so would hand over
the exact knowledge the game tests. Disambiguation therefore uses the least
revealing thing that works:

1. **Plain name** when unique — `Zlatan Ibrahimović`, `Danny Blind`, `Daley Blind`
2. **Plain name + birth year** when two players share an identical name —
   `Fred (1983)` / `Fred (1993)`

Birth year leaks era, a far weaker signal than clubs, and appears only in the
rare exact-collision case.

An earlier draft had a middle tier shortening to initial + surname
(`C. Ronaldo`). It was removed as unreachable: a tier-1 collision means two
*identical* name strings, and shortening identical strings yields identical
results, so the tier could never resolve anything. Full names are also clearer
in a dropdown and equally club-free.

**Mononyms** (Hulk, Fred, Oscar, Rivaldo) need no special handling under this
scheme — they are just names, and fall through to birth year if they collide.

### A non-issue, recorded so it is not re-litigated

Every player in the dataset played for at least one of the 100 clubs, so it may
look as though appearing in the autocomplete guarantees a point. It does not.
Scoring is against the round's ~5 chosen clubs, not the full 100. A player with
two list clubs has roughly a 90% chance of matching none of the five in play, so
the overwhelming majority of typeable names score zero. There is no meaningful
information leak and no mitigation needed.

### The real data risk

Wikidata gaps. A genuine journeyman missing from the extract cannot be named at
all, because he will not autocomplete. This is the accepted cost of choosing
Wikidata over Transfermarkt.

The "best possible answer" shown at reveal is computed from the same dataset, so
the game stays internally consistent: it never claims an answer existed that a
player could not have typed.

## Best possible answer

At reveal, the game shows the footballer in the dataset covering the most of
that round's clubs. A linear scan over ~25k players — trivially fast.

This earns its place twice: it turns each round into a small lesson, and it
proves the round was winnable.

## Protocol

WebSocket. The server broadcasts a **full room snapshot** on every state change,
plus lightweight timer ticks. Clients render the latest snapshot rather than
applying deltas, which makes reconnection trivial — a returning client just
receives the current snapshot.

| Direction | Messages |
|---|---|
| Client → server | `join`, `start`, `pickClub`, `submitAnswer` |
| Server → client | `roomState`, `tick`, `clubLocked`, `answerRejected`, `roundResult`, `final` |

## Failure handling

- **Disconnect mid-game** — score retained, player marked offline, phases
  auto-advance without them. Reconnect via the same room code and nickname.
- **Fewer than two players** — the game cannot start.
- **Server restart** — live games are lost. Accepted.
- **Malformed or oversized messages** — rejected at the socket boundary before
  reaching the engine.

## UI

Four screens: lobby, club picking, answering, scoreboard. Phone-first
throughout — the club grid has to be usable with a thumb.

Built in two passes, deliberately in this order:

**Pass 1 — playable.** A functional UI in plain semantic HTML and hand-written
CSS: readable, phone-sized, no framework, no build step. The goal is a game
that can be played with friends, not a beautiful one.

**Pass 2 — designed.** After playtesting, the visual direction is authored in
**Google Stitch** and applied. Stitch produces static screens; the interaction
layer built in pass 1 stays and is restyled underneath.

The ordering is the point. Designing four screens before anyone has played
risks styling a flow that playtesting changes — if 15 seconds turns out to be
too short, or the reveal needs to show more, that is a layout change discovered
*after* the design work. A playable prototype answers those questions first, and
it gives Stitch a real thing to design against instead of a description.

This also defers the Tailwind-versus-no-build-step question until it is
actually a question. If pass 2 brings Tailwind, it is served via CDN or
converted to plain CSS; the container must stay buildable without a frontend
toolchain.

## Security

- Binds `127.0.0.1` only; never the public interface.
- Cloudflare quick tunnel is outbound-only — no inbound firewall rules, home IP
  not exposed.
- Container runs as a non-root user.
- Room codes are 6 random characters and expire when the room empties.
- Room creation is rate-limited per IP.
- Caps: 24-character nicknames, 8 players per room, 4 KB messages.
- No personal data is stored — nickname only, in memory, discarded with the room.

## Testing

Pure and offline, no network required:

- **Engine** — scoring maths, distinct-club enforcement, claim-race ordering,
  the grace window, timeout auto-assignment, disconnect handling, round
  progression, end-of-game.
- **Dataset** — assertions against known careers. Ibrahimović must score 7
  against Ajax, Juventus, Inter, Barcelona, Milan, PSG and Manchester United.
  Disambiguation must produce `D. Blind (1961)` and `D. Blind (1990)`, and must
  never emit a club name.
- **Protocol** — message validation and rejection of malformed input.

The build script is exercised separately against live Wikidata, deliberately
outside the normal test run, so an upstream outage cannot redden the build.

## Out of scope

- Accounts, persistence, historical stats, global leaderboards.
- Public room discovery, matchmaking, moderation.
- Spectators, chat, rejoining a finished game.
- Non-football sports, other data sources (until the adapter is swapped).
