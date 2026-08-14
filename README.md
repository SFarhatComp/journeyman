# FootFinder

A multiplayer football trivia game for friends. Everyone joins a private room
by code on their phones, and the game runs live for a few rounds.

## How it's played

1. One player creates a room and shares the code (and the tunnel URL) with
   friends. 2–8 players join by nickname.
2. Each round, every player picks a distinct club from the round's grid
   before the pick timer runs out. No two players can hold the same club;
   whoever doesn't pick in time is auto-assigned one.
3. Once everyone has a club, each player has to name one footballer — just
   one name, not one per club.
4. You score one point for every club you claimed that the footballer you
   named actually played for. Naming someone who played for all the clubs
   you're holding is the best possible answer for that round.
5. After 8 rounds, whoever has the highest total wins.

## Quick start

Nothing is installed on the host — everything runs in Docker via
`./footfinder.sh`.

```bash
./footfinder.sh build     # build the image
./footfinder.sh test      # run the test suite in a container
./footfinder.sh up        # start the game server (binds 127.0.0.1:3000)
./footfinder.sh down      # stop and remove the container
./footfinder.sh logs      # follow the server's logs
./footfinder.sh tunnel    # expose the running server to the internet
./footfinder.sh dataset   # regenerate data/dataset.json from Wikidata
```

## Playing with friends

```bash
./footfinder.sh up
./footfinder.sh tunnel
```

`tunnel` runs `cloudflared` in Docker and prints a `https://….trycloudflare.com`
URL to stdout. It runs in the foreground (Ctrl-C closes it), so run it in a
terminal you're going to leave open for the session. Share the printed URL
and the in-game room code with friends; they open the URL on their phones
and join with the code.

The tunnel URL is different every time — there's no way to bookmark it
ahead of a session. When you're done, Ctrl-C the tunnel and run
`./footfinder.sh down`. Leaving the tunnel up leaves a public URL pointed at
this machine.

## The data

The game ships with a curated, fixed set of **97 European clubs** and
**52,175 players**, extracted from Wikidata at build time into
`data/dataset.json`. That file is committed to the repo and baked into the
Docker image, so the running game never calls Wikidata — it's fully
self-contained and works offline.

The club list (`data/clubs.json`) is hand-curated: each entry's Wikidata QID
was manually looked up and verified, not scraped or inferred. This keeps
national teams and lookalike entities out of the pool and avoids having to
classify arbitrary Wikidata items as "is this really a club."

To pull a fresh snapshot from Wikidata (e.g. after editing `clubs.json`, or
to pick up newly-added transfers):

```bash
./footfinder.sh dataset
```

This overwrites `data/dataset.json`. Review the diff and commit it like any
other change.

## Architecture

- **`src/engine/`** — the game's state machine (`room.js`) and scoring logic
  (`scoring.js`). Pure functions: no I/O, no clock, no dataset imports. The
  current time and the dataset are both passed in as arguments. This is what
  makes the timing rules (pick timeout, answer window, grace period) testable
  without real waiting or a running server.
- **`src/server.js`** — a thin shell around the engine: serves static files,
  exposes the room-creation/search HTTP API, and drives the engine's state
  machine over WebSocket messages.
- **`src/dataset/`** — the Wikidata adapter (`fromWikidata.js`), player-name
  lookup (`label.js`), and dataset loading (`load.js`). Isolated from the
  engine so the data source could be swapped later without touching game
  logic.
- **`public/`** — a plain-JS, no-build-step frontend (`app.js`, `index.html`,
  `style.css`). No bundler, no framework.

## Security posture

- The server binds `127.0.0.1` only inside the container (`docker run -p
  127.0.0.1:3000:3000`) — it is never reachable on the host's public
  interface, and no router port needs to be opened.
- The tunnel (`cloudflared`) is outbound-only: it dials out to Cloudflare
  and Cloudflare proxies traffic in, so the host's IP address is never
  exposed to players.
- The container runs as a non-root user (`node`), set explicitly in the
  Dockerfile.
- The room code is the only access control. Anyone with the code (and the
  current tunnel URL) can join — treat both as the shared secret for a
  session.
- Room creation is rate-limited per IP (a token bucket: 5 immediate, 1
  refilled per minute) to keep the room list from being spammed.

## Known limits

- **No persistence.** All game state lives in memory. Restarting the server
  (including a container restart) drops every in-progress game.
- **Wikidata coverage gaps.** A handful of real players who played for a
  curated club aren't nameable, because Wikidata has no English label for
  them, or is missing the club-tenure statement. These show up as genuine
  journeymen you can't credit.
- **Playable, not polished.** The UI (`public/`) is the functional pass —
  it works and is playable end to end, but the visual design is
  deliberately unstyled/minimal. A design pass is future work.
- **The tunnel URL isn't stable.** Every `./footfinder.sh tunnel` run mints
  a new `trycloudflare.com` subdomain. There's no way to give friends a
  fixed link across sessions without a paid Cloudflare tunnel.
