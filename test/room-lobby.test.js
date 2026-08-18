import test from "node:test";
import assert from "node:assert/strict";
import { createRoom, addPlayer, startGame, beginRound, DEFAULT_CONFIG , setRounds, ROUND_OPTIONS, setSport, SPORTS } from "../src/engine/room.js";

const DEPS = {
  clubs: [
    { id: "Q1", name: "Club One", country: "EN" },
    { id: "Q2", name: "Club Two", country: "ES" },
    { id: "Q3", name: "Club Three", country: "IT" },
  ],
  getPlayerClubs: () => [],
  findBest: () => null,
};

const withPlayers = (n) => {
  let state = createRoom({ code: "ABC123" });
  for (let i = 0; i < n; i++) {
    state = addPlayer(state, { id: `p${i}`, nickname: `Player ${i}` }).state;
  }
  return state;
};

test("a new room starts in the lobby with no players", () => {
  const state = createRoom({ code: "ABC123" });
  assert.equal(state.phase, "LOBBY");
  assert.equal(state.code, "ABC123");
  assert.deepEqual(state.players, []);
  assert.equal(state.config.rounds, DEFAULT_CONFIG.rounds);
});

test("the first player to join becomes the host", () => {
  const state = withPlayers(2);
  assert.equal(state.hostId, "p0");
});

test("players join with a zero score and connected", () => {
  const state = withPlayers(1);
  assert.deepEqual(state.players[0], { id: "p0", nickname: "Player 0", score: 0, connected: true });
});

test("a room cannot exceed maxPlayers", () => {
  const full = withPlayers(DEFAULT_CONFIG.maxPlayers);
  const res = addPlayer(full, { id: "extra", nickname: "Late" });
  assert.equal(res.error, "room_full");
  assert.equal(res.state.players.length, DEFAULT_CONFIG.maxPlayers);
});

test("a duplicate nickname is rejected so the scoreboard stays readable", () => {
  const state = withPlayers(1);
  const res = addPlayer(state, { id: "p9", nickname: "Player 0" });
  assert.equal(res.error, "nickname_taken");
});

test("rejoining with the same id reconnects, keeping the seat and the score", () => {
  let state = withPlayers(2);
  // Simulate a game in progress: p0 has points, then drops offline.
  state = {
    ...state,
    players: state.players.map((p) => (p.id === "p0" ? { ...p, score: 7, connected: false } : p)),
  };

  const res = addPlayer(state, { id: "p0", nickname: "Player 0" });
  const p0 = res.state.players.find((p) => p.id === "p0");

  assert.equal(res.error, undefined);
  assert.equal(res.state.players.length, 2, "must not create a second seat");
  assert.equal(p0.connected, true);
  assert.equal(p0.score, 7, "a phone reload must not cost you your points");
});

test("the game will not start with fewer than two players", () => {
  const res = startGame(withPlayers(1), 1000, DEPS);
  assert.equal(res.error, "not_enough_players");
  assert.equal(res.state.phase, "LOBBY");
});

test("starting moves to PICKING with round 1 and a deadline", () => {
  const res = startGame(withPlayers(3), 1000, DEPS);
  assert.equal(res.state.phase, "PICKING");
  assert.equal(res.state.round.number, 1);
  // The backstop, not the visible clock — that one only arms when one player
  // is left to choose.
  assert.equal(res.state.phaseEndsAt, 1000 + DEFAULT_CONFIG.pickMaxSeconds * 1000);
  assert.equal(res.state.round.pickTimerArmed, false);
});

test("the game will not start without enough clubs for every player", () => {
  // Three players need three distinct clubs.
  const res = startGame(withPlayers(3), 1000, { ...DEPS, clubs: [{ id: "Q1", name: "Only", country: "EN" }] });
  assert.equal(res.error, "not_enough_clubs");
});

test("starting an already-started game is rejected and changes nothing", () => {
  const started = startGame(withPlayers(2), 1000, DEPS).state;
  const res = startGame(started, 2000, DEPS);

  assert.equal(res.error, "already_started");
  assert.equal(res.state.phase, "PICKING");
  assert.equal(res.state.round.number, 1, "the running game must be untouched");
});

test("no mutator touches the state it was given", () => {
  const base = withPlayers(3);
  const snapshot = structuredClone(base);

  addPlayer(base, { id: "p9", nickname: "New" });
  assert.deepEqual(base, snapshot, "addPlayer mutated its input");

  startGame(base, 1000, DEPS);
  assert.deepEqual(base, snapshot, "startGame mutated its input");

  // beginRound is exported for Task 9's next-round transition, so it must be
  // pure on its own terms — not merely safe when startGame happens to clone.
  const started = startGame(base, 1000, DEPS).state;
  const startedSnapshot = structuredClone(started);
  beginRound(started, 2, 5000);
  assert.deepEqual(started, startedSnapshot, "beginRound mutated its input");
});

test("a new player cannot join a game already in progress", () => {
  const started = startGame(withPlayers(2), 1000, DEPS).state;
  const res = addPlayer(started, { id: "late", nickname: "Latecomer" });

  assert.equal(res.error, "game_in_progress");
  assert.equal(res.state.players.length, 2, "the latecomer must not get a seat");
});

test("an existing player may still reconnect mid-game", () => {
  let started = startGame(withPlayers(2), 1000, DEPS).state;
  started = {
    ...started,
    players: started.players.map((p) => (p.id === "p0" ? { ...p, connected: false } : p)),
  };

  const res = addPlayer(started, { id: "p0", nickname: "Player 0" });

  assert.equal(res.error, undefined, "reconnect must not be blocked by the phase guard");
  assert.equal(res.state.players.find((p) => p.id === "p0").connected, true);
});

test("the host can set the game length to any offered option", () => {
  for (const rounds of ROUND_OPTIONS) {
    const res = setRounds(withPlayers(2), rounds);
    assert.equal(res.error, undefined);
    assert.equal(res.state.config.rounds, rounds);
  }
});

test("a game length that is not on offer is refused", () => {
  // Otherwise a crafted message could ask for 500 rounds, or 0.
  for (const bad of [0, 1, 7, 100, -4, 2.5]) {
    assert.equal(setRounds(withPlayers(2), bad).error, "bad_rounds", `${bad} must be refused`);
  }
});

test("the game length cannot be changed once play has started", () => {
  // Moving the finish line mid-game could end it retroactively, or move it
  // out from under players who had paced themselves against it.
  const playing = { ...withPlayers(2), phase: "PICKING" };
  assert.equal(setRounds(playing, 4).error, "wrong_phase");
});

test("setting the game length leaves the state it was given untouched", () => {
  const base = withPlayers(2);
  const snapshot = structuredClone(base);
  setRounds(base, 4);
  assert.deepEqual(base, snapshot, "setRounds mutated its input");
});

test("the host can choose any sport the engine knows", () => {
  for (const sport of SPORTS) {
    const res = setSport(withPlayers(2), sport);
    assert.equal(res.error, undefined);
    assert.equal(res.state.config.sport, sport);
  }
});

test("a sport that is not on offer is refused", () => {
  // The pool is drawn from the sport's own dataset, so an unknown name would
  // leave the round with no clubs to pick from at all.
  for (const bad of ["cricket", "", "FOOTBALL", null, 7]) {
    assert.equal(setSport(withPlayers(2), bad).error, "bad_sport", `${bad} must be refused`);
  }
});

test("the sport cannot change once play has started", () => {
  // Players would be holding teams that do not exist in the dataset being
  // scored against.
  const playing = { ...withPlayers(2), phase: "PICKING" };
  assert.equal(setSport(playing, "hockey").error, "wrong_phase");
});

test("a new room defaults to football", () => {
  assert.equal(createRoom({ code: "ABC123" }).config.sport, "football");
});

test("setting the sport leaves the state it was given untouched", () => {
  const base = withPlayers(2);
  const snapshot = structuredClone(base);
  setSport(base, "hockey");
  assert.deepEqual(base, snapshot, "setSport mutated its input");
});
