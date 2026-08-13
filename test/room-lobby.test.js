import test from "node:test";
import assert from "node:assert/strict";
import { createRoom, addPlayer, startGame, DEFAULT_CONFIG } from "../src/engine/room.js";

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

test("rejoining with the same id reconnects rather than duplicating", () => {
  let state = withPlayers(1);
  state = { ...state, players: state.players.map((p) => ({ ...p, connected: false })) };
  const res = addPlayer(state, { id: "p0", nickname: "Player 0" });
  assert.equal(res.error, undefined);
  assert.equal(res.state.players.length, 1);
  assert.equal(res.state.players[0].connected, true);
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
  assert.equal(res.state.phaseEndsAt, 1000 + DEFAULT_CONFIG.pickSeconds * 1000);
});

test("the game will not start without enough clubs for every player", () => {
  // Three players need three distinct clubs.
  const res = startGame(withPlayers(3), 1000, { ...DEPS, clubs: [{ id: "Q1", name: "Only", country: "EN" }] });
  assert.equal(res.error, "not_enough_clubs");
});

test("mutators never mutate the state passed in", () => {
  const before = withPlayers(2);
  const snapshot = structuredClone(before);
  startGame(before, 1000, DEPS);
  assert.deepEqual(before, snapshot);
});
