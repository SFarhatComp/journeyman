import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { createDataset } from "./dataset/load.js";
import { findBestAnswer } from "./engine/scoring.js";
import { parseMessage, snapshotFor } from "./protocol.js";
import {
  createRoom, addPlayer, startGame, pickClub, submitAnswer, expirePhase, disconnect, endGame, playAgain,
} from "./engine/room.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

const raw = JSON.parse(await readFile(new URL("../data/dataset.json", import.meta.url), "utf8"));
const dataset = createDataset(raw);
console.log(`dataset: ${dataset.players.length} players, ${dataset.clubs.length} clubs`);

const deps = {
  clubs: dataset.clubs,
  getPlayerClubs: (id) => dataset.getPlayerClubs(id),
  getPlayerLabel: (id) => dataset.getPlayerLabel(id),
  findBest: (roundClubIds) => findBestAnswer(roundClubIds, dataset.players),
};

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
const server = createServer(async (req, res) => {
  if (req.url === "/api/clubs") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(dataset.clubs));
  }
  if (req.url?.startsWith("/api/search?")) {
    const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(dataset.search(q)));
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

  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  // One optional subdirectory, for /crests/Q18656.png. The explicit ".." test
  // is what actually stops traversal: "." is a legal filename character, so
  // the character class alone would happily match "/../etc".
  if (!/^\/[\w.-]+(\/[\w.-]+)?$/.test(path) || path.includes("..")) {
    res.writeHead(404);
    return res.end();
  }
  try {
    const body = await readFile(new URL(`../public${path}`, import.meta.url));
    const ext = path.slice(path.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(body);
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
      case "start":
        if (playerId !== room.state.hostId) result = { state: room.state, error: "not_host" };
        else result = startGame(room.state, now, deps);
        break;
      case "pickClub":
        result = pickClub(room.state, { playerId, clubId: msg.payload.clubId }, now, deps);
        break;
      case "submitAnswer":
        result = submitAnswer(room.state, { playerId, entityId: msg.payload.entityId }, now, deps);
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
    const result = expirePhase(room.state, now, deps);
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
