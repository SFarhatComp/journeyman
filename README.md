# FootFinder

A multiplayer football trivia game for friends. Everyone joins a private room
by code on their phones, and the game runs live for a few rounds.

## How it's played

1. One player creates a room and shares the invite link. 2–8 players join by
   nickname. The host picks the game length: **4, 6 or 8 rounds** (default 6).
2. Each round, every player claims a club from a grid of 97. **Nobody can see
   what anyone else has taken.** If two players happen to claim the same club,
   one keeps it at random and the other is moved to a free club and told so —
   speed doesn't decide it, because nobody could see the collision coming.
3. Once everyone holds a club, each player names **one footballer** — one
   name total, not one per club.
4. You score **one point per club you're holding that the footballer actually
   played for**. Naming someone who turned out for every club in the round is
   the best possible answer.
5. Highest total after the last round wins.

**The clocks start late.** There's no countdown while several people are still
deciding — it only starts once everyone *but one* has locked in, and only that
last player is under it. Same for picking (20s) and answering (30s). An unseen
backstop stops an abandoned room hanging forever.

**Claimed footballers are public as they land.** A name already taken is
rejected, so seeing them can't help you copy — it just stops you burning your
round discovering by trial and error which names are gone. Lose a race by
milliseconds and you get a few seconds of personal grace to name someone else.

## Quick start

Nothing is installed on the host — everything runs in Docker via
`./footfinder.sh`.

```bash
./footfinder.sh build     # build the image
./footfinder.sh test      # run the test suite in a container (159 tests)
./footfinder.sh up        # start the game server (http://127.0.0.1:3000)
./footfinder.sh down      # stop the server AND close the tunnel if open
./footfinder.sh logs      # follow the server's logs
./footfinder.sh tunnel    # expose the running server to the internet
./footfinder.sh dataset   # rebuild data/dataset.json from Wikidata
./footfinder.sh enrich    # fill career gaps from Wikipedia infoboxes
./footfinder.sh crests    # re-download club crests
```

## Playing with friends

```bash
./footfinder.sh up
./footfinder.sh tunnel
```

`tunnel` runs `cloudflared` in Docker and prints a `https://….trycloudflare.com`
URL. It runs in the foreground, so leave that terminal open for the session.

Open the URL, create a room, and hit **Share invite link** — it sends a link
with the room code already in it, so friends just open it, type a name and tap
Join. The tunnel URL changes every run, so it can't be bookmarked ahead of
time.

When you're done, `./footfinder.sh down` stops the server *and* the tunnel.
That's the reliable way to be sure no public URL to this machine is left
running — Ctrl-C alone can fail if the shell is killed (see Known limits).

## The data

A curated, fixed set of **97 European clubs** and **52,215 players**, built
into `data/dataset.json` (5.0M, committed and baked into the image). The
running game never calls the network — it's fully self-contained.

`data/clubs.json` is hand-curated: every Wikidata QID was looked up and
verified rather than scraped. That keeps national teams and lookalike entities
out of the pool, and means the game never has to decide whether an arbitrary
Wikidata item is "really a club".

### Two sources, in two passes

`./footfinder.sh dataset` pulls club rosters from **Wikidata**'s P54
statements. `./footfinder.sh enrich` then fills the gaps from **Wikipedia**
career infoboxes.

**They are ordered, and the order matters.** `dataset` rewrites
`data/dataset.json` from scratch, which silently discards everything `enrich`
added. Always run `enrich` after `dataset`, or 1,885 club links vanish and
nothing tells you.

The second pass exists because the first is quietly incomplete. Wikidata had
João Félix at Chelsea and AC Milan, with no Benfica, no Atlético Madrid and no
Barcelona — and an entry for FCSB, a Romanian club, where the Barcelona loan
belongs. His Wikipedia infobox lists every club correctly. Those tables are
maintained by people who follow the sport, so they're materially better for the
one question this game asks. The pass added **1,885 club links across 1,477
players**.

Enrichment is **additive**: it never removes a club Wikidata asserted. Two
sources disagreeing isn't evidence about which is wrong, and a pass that can
delete is one that can quietly gut 52,215 players. Every change is written to
`data/enrich-report.json` so the diff can be read before it's trusted. Both
passes cache aggressively, so an interrupted run resumes.

Club crests (`public/crests/`, 1.7MB) are joined by exact QID — Wikidata
sitelink to Wikipedia article to lead image — never by name matching.

## Architecture

- **`src/engine/`** — the state machine (`room.js`) and scoring
  (`scoring.js`). Pure functions: no I/O, no clock, no dataset imports. Time
  arrives as an argument, the dataset as `deps`. That's what makes the timing
  rules testable without waiting or a server. Every exported mutator clones
  its input; a test asserts none of them mutate.
- **`src/protocol.js`** — the socket boundary, and the single definition of
  what a client is allowed to see. Club picks are withheld during PICKING;
  entity ids and timestamps are never sent at all.
- **`src/server.js`** — a thin shell: static files with cache headers,
  the room/search HTTP API, and the engine driven over WebSocket.
- **`src/dataset/`** — adapters for Wikidata (`fromWikidata.js`) and
  Wikipedia (`fromWikipedia.js`), name formatting (`label.js`), and search
  (`load.js`). Isolated from the engine so the source can change without
  touching game logic.
- **`src/static-path.js`** — request path to file, or a refusal. Its own
  module because importing `server.js` loads a 5MB dataset and binds a port,
  and a guard that needs a running server to test doesn't get tested.
- **`public/`** — plain-JS frontend, no build step, no bundler, no framework.

### Frontend performance

The game is played on phones over a tunnel, so first paint is **~38KB** of
HTML, CSS and font — one round trip, no render-blocking JS.

- CSS is hand-written from the design system's tokens. A Tailwind CDN build
  ships a compiler that runs on every page load, which is the opposite of what
  this needs.
- Oswald is self-hosted and subset (48KB, `unicode-range` split), saving a DNS
  and TLS handshake to Google before any text can render. Body text is
  `system-ui`: instant, zero bytes.
- Crests are 128px and lazy-loaded; the 97-card grid only re-renders when
  *your own* pick changes.
- The server broadcasts only when a tick produces an event. Clients run their
  own countdown from `phaseEndsAt`.
- Crests and fonts cache for a month and a year; HTML/CSS/JS revalidate with
  an ETag, so a reload costs a 304 rather than 1.7MB.

## Security posture

- The container publishes to `127.0.0.1:3000` on the host only, so the game is
  unreachable from your local network. (The process binds `0.0.0.0` *inside*
  the container, which Docker's port mapping requires — the loopback
  restriction is enforced by the host-side publish, not the process.) No
  router port needs opening.
- The tunnel is outbound-only: `cloudflared` dials out and Cloudflare proxies
  traffic in, so the host's IP is never exposed to players.
- The container runs as a non-root user (`node`), set in the Dockerfile.
- The room code is the only access control. Anyone with the code and the
  current tunnel URL can join — treat both as a shared secret for the session.
- Room creation is rate-limited per IP (token bucket: 5 immediate, 1 per
  minute).
- Nicknames are escaped everywhere they're rendered; the static path guard
  refuses traversal, including behind a query string.

## Known limits

- **No persistence.** All state is in memory. Restarting the server drops
  every in-progress game.
- **Data gaps remain.** Enrichment only touches players already in the
  dataset — someone whose Wikidata has no link to any of the 97 clubs isn't
  there to enrich, even if Wikipedia says they played for Barcelona. And the
  pass can't fix *wrong* data, only missing data: Wikidata still claims João
  Félix played for FCSB.
- **Wikidata labels are occasionally vandalised.** Q1042372's English label
  reads "don panini"; he's Carlo Parola. Eight such labels were repaired from
  their article titles, but the general problem is upstream.
- **Some players have no English label at all.** Luka Modrić's entity carries
  59 labels and not one in English, so he was dropped as unnameable — invisible
  in a football game. The builder now falls back to the Wikipedia article
  title, which recovered 31 of the 255 players in that state. The other 224
  have no English article either, so there is genuinely nothing to call them.
- **Rebuilding is flaky and slow.** The query service throttles under the
  sustained load of 97 roster queries and starts truncating responses
  mid-JSON. Rosters are cached per club, so a failed run resumes rather than
  restarting — but expect a full rebuild to take two or three invocations.
- **Search ranks by club count, not fame.** Typing `xavi` leads with Xavi
  Simons rather than Xavi Hernández, because Simons appears in more of the 97
  clubs. Typing a fuller name fixes it.
- **The tunnel URL isn't stable.** Every run mints a new subdomain. A fixed
  link needs a paid Cloudflare tunnel.
- **A tunnel can outlive its terminal.** If the shell is killed or an SSH
  session drops, the cloudflared container can survive and keep the URL live.
  `./footfinder.sh down` is the reliable close.
- **Everyone dropping at once costs a round.** If every phone locks mid-game,
  the backstop timers keep running while nobody is connected.
- **Rate limiting is per-tunnel, not per-person.** Behind a tunnel every
  request arrives from the same address, so the five-rooms-per-minute budget
  is shared by everyone at the table.
- **A disconnect mid-pick stalls the round.** With no clock until one player
  is left, a player who drops during picking holds the phase until the 60s
  backstop expires.
