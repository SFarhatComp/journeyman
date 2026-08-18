import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { createDataset } from "./dataset/load.js";
import { findBestAnswer } from "./engine/scoring.js";
import { parseMessage, snapshotFor } from "./protocol.js";
import { resolveStaticPath } from "./static-path.js";
import {
  createRoom, addPlayer, startGame, pickClub, submitAnswer, expirePhase, disconnect, endGame, playAgain,
  setRounds, setSport,
} from "./engine/room.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

/**
 * One dataset per sport, chosen per room.
 *
 * The engine never learns which sport it is running: it takes `deps`, and
 * every sport supplies the same four functions over the same shape. That is
 * why adding hockey needed no engine change at all — the five mentions of
 * "football" in engine and protocol were comments.
 */
const SPORTS = {
  football: { file: "../data/dataset.json", noun: "footballer", unit: "club" },
  hockey: { file: "../data/nhl-dataset.json", noun: "hockey player", unit: "team" },
};

const datasets = {};
for (const [sport, meta] of Object.entries(SPORTS)) {
  try {
    const raw = JSON.parse(await readFile(new URL(meta.file, import.meta.url), "utf8"));
    datasets[sport] = createDataset(raw);
    console.log(`${sport}: ${datasets[sport].players.length} players, ${datasets[sport].clubs.length} ${meta.unit}s`);
  } catch (err) {
    // A missing dataset disables that sport rather than stopping the server.
    // Losing one game is better than losing both.
    console.log(`${sport}: unavailable (${err.code ?? err.message})`);
  }
}
if (Object.keys(datasets).length === 0) throw new Error("no datasets — cannot serve any game");

export const availableSports = Object.keys(datasets);
const DEFAULT_SPORT = availableSports.includes("football") ? "football" : availableSports[0];

const depsCache = {};
function depsFor(sport) {
  const key = datasets[sport] ? sport : DEFAULT_SPORT;
  if (depsCache[key]) return depsCache[key];
  const d = datasets[key];
  depsCache[key] = {
    clubs: d.clubs,
    getPlayerClubs: (id) => d.getPlayerClubs(id),
    getPlayerLabel: (id) => d.getPlayerLabel(id),
    findBest: (roundClubIds) => findBestAnswer(roundClubIds, d.players),
  };
  return depsCache[key];
}

/** The deps a given room plays with, decided by its own config. */
const roomDeps = (room) => depsFor(room.state.config?.sport ?? DEFAULT_SPORT);

/** code -> { state, sockets: Map<playerId, ws> } */
const rooms = new Map();
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

// A room nobody ever joined is junk; a room everyone briefly dropped out of
// is not. Both are reaped by the same sweep, on different clocks.
const ROOM_UNJOINED_TTL_MS = 30 * 60_000;
const ROOM_EMPTY_GRACE_MS = 2 * 60_000;

function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}

// Per-IP token bucket: 5 rooms, refilling one per minute. Rooms are cheap but
// unbounded creation is a memory leak with a URL anyone can share on.
const buckets = new Map();
function allowRoomCreation(ip) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: 5, last: now };
  b.tokens = Math.min(5, b.tokens + (now - b.last) / 60_000);
  b.last = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

function broadcast(room) {
  for (const [playerId, ws] of room.sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "snapshot", payload: snapshotFor(room.state, playerId) }));
    }
  }
}

function apply(room, result) {
  room.state = result.state;
  broadcast(room);
  return result;
}

// Static files. Tiny hand-rolled server — three files, no framework needed.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".png": "image/png", ".svg": "image/svg+xml",
               ".woff2": "font/woff2" };

/**
 * Nothing was sending cache headers, so 1.5MB of crests came down the tunnel
 * again on every load and every reconnect — and with no validator either, the
 * browser could not even ask "still fresh?".
 *
 * Crests are named by Wikidata QID and fonts by script subset, so a given
 * filename's bytes never change; those cache hard. The page, script and
 * stylesheet do change on every deploy and carry no content hash in their
 * names, so they must revalidate — the ETag turns that into a 304 rather than
 * a re-download. Crests get a month rather than a year, so re-running the
 * crest fetch is not pinned behind a stale cache until 2027.
 */
function cacheControl(path) {
  if (path.startsWith("/fonts/")) return "public, max-age=31536000, immutable";
  if (path.startsWith("/crests/")) return "public, max-age=2592000";
  return "no-cache";
}
const server = createServer(async (req, res) => {
  // Both take ?sport=, defaulting to whatever is loaded. An unknown sport
  // falls back rather than 404ing: a stale client asking the wrong question
  // should still get a playable answer.
  const sportOf = (url) => {
    const asked = new URL(url, "http://x").searchParams.get("sport");
    return datasets[asked] ? asked : DEFAULT_SPORT;
  };

  if (req.url === "/api/sports") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(availableSports));
  }
  if (req.url?.startsWith("/api/clubs")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(datasets[sportOf(req.url)].clubs));
  }
  if (req.url?.startsWith("/api/search?")) {
    const url = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(datasets[sportOf(req.url)].search(url.searchParams.get("q") ?? "")));
  }
  if (req.method === "POST" && req.url === "/api/room") {
    if (!allowRoomCreation(req.socket.remoteAddress ?? "unknown")) {
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "slow_down" }));
    }
    const code = newCode();
    rooms.set(code, { state: createRoom({ code }), sockets: new Map(), createdAt: Date.now(), emptiedAt: null });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ code }));
  }

  const path = resolveStaticPath(req.url);
  if (!path) {
    res.writeHead(404);
    return res.end();
  }
  try {
    const file = new URL(`../public${path}`, import.meta.url);
    const info = await stat(file);
    const ext = path.slice(path.lastIndexOf("."));
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": cacheControl(path),
      etag,
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const code = (url.searchParams.get("code") ?? "").toUpperCase();
  const room = rooms.get(code);
  if (!room) return ws.close(4004, "no such room");

  // The client keeps this so a reload rejoins as the same player.
  const playerId = url.searchParams.get("playerId") || randomUUID();
  ws.send(JSON.stringify({ type: "identity", payload: { playerId } }));

  ws.on("message", (data) => {
    const msg = parseMessage(data.toString());
    if (msg.error) return ws.send(JSON.stringify({ type: "error", payload: { error: msg.error } }));

    const now = Date.now();
    let result;
    switch (msg.type) {
      case "join":
        result = addPlayer(room.state, { id: playerId, nickname: msg.payload.nickname.trim() });
        if (!result.error) room.sockets.set(playerId, ws);
        break;
      case "playAgain":
        if (playerId !== room.state.hostId) result = { state: room.state, error: "not_host" };
        else result = playAgain(room.state);
        break;
      case "endGame":
        // Host only: ending someone else's game would be a griefing vector.
        if (playerId !== room.state.hostId) result = { state: room.state, error: "not_host" };
        else result = endGame(room.state);
        break;
      case "setRounds":
        // Host only, like start and endGame: the game length is not something
        // any player should be able to change out from under the room.
        if (playerId !== room.state.hostId) result = { state: room.state, error: "not_host" };
        else result = setRounds(room.state, msg.payload.rounds);
        break;
      case "setSport":
        // Host only, and the server refuses a sport it has no dataset for —
        // the engine allows any name in SPORTS, but only loaded ones playable.
        if (playerId !== room.state.hostId) result = { state: room.state, error: "not_host" };
        else if (!datasets[msg.payload.sport]) result = { state: room.state, error: "sport_unavailable" };
        else result = setSport(room.state, msg.payload.sport);
        break;
      case "start":
        if (playerId !== room.state.hostId) result = { state: room.state, error: "not_host" };
        else result = startGame(room.state, now, roomDeps(room));
        break;
      case "pickClub":
        result = pickClub(room.state, { playerId, clubId: msg.payload.clubId }, now, roomDeps(room));
        break;
      case "submitAnswer":
        result = submitAnswer(room.state, { playerId, entityId: msg.payload.entityId }, now, roomDeps(room));
        break;
      default:
        return;
    }
    if (result.error) ws.send(JSON.stringify({ type: "error", payload: { error: result.error } }));
    apply(room, result);
  });

  ws.on("close", () => {
    // If this is not the live socket, a reconnect already replaced it. Doing
    // anything here would mark a currently-connected player offline, and
    // nothing would clear that.
    if (room.sockets.get(playerId) !== ws) return;
    room.sockets.delete(playerId);
    apply(room, disconnect(room.state, playerId));
    if (room.sockets.size === 0) room.emptiedAt = Date.now();
  });
});

// One timer drives every room's phase expiry. The engine decides what expiry
// means; this only supplies the clock. It also reaps abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.sockets.size > 0) {
      room.emptiedAt = null;          // someone is back
    } else {
      // Unjoined rooms get a long TTL; rooms that emptied mid-game get a
      // short one, long enough to survive a phone locking.
      const since = room.emptiedAt ?? room.createdAt;
      const ttl = room.emptiedAt ? ROOM_EMPTY_GRACE_MS : ROOM_UNJOINED_TTL_MS;
      if (now - since > ttl) {
        rooms.delete(code);
        console.log(`${code}: reaped (${room.emptiedAt ? "empty" : "never joined"})`);
        continue;
      }
    }

    if (room.state.phaseEndsAt === null) continue;
    const before = room.state.phase;
    const result = expirePhase(room.state, now, roomDeps(room));
    room.state = result.state;
    // Only broadcast when the tick actually changed something. Clients run
    // their own countdown from phaseEndsAt, so a per-second snapshot to every
    // player was pure traffic — and it forced a full re-render every second on
    // the one screen where people are trying to tap.
    if (result.events.length > 0) broadcast(room);
    if (before !== room.state.phase) console.log(`${room.state.code}: ${before} -> ${room.state.phase}`);
  }
}, 1000);

server.listen(PORT, HOST, () => console.log(`footfinder on http://${HOST}:${PORT}`));
