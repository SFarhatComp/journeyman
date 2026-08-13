import test from "node:test";
import assert from "node:assert/strict";
import { createRoom, addPlayer, startGame, pickClub, expirePhase, DEFAULT_CONFIG } from "../src/engine/room.js";

const DEPS = {
  clubs: [
    { id: "Q1", name: "Club One", country: "EN" },
    { id: "Q2", name: "Club Two", country: "ES" },
    { id: "Q3", name: "Club Three", country: "IT" },
  ],
  getPlayerClubs: () => [],
  findBest: () => null,
  random: () => 0, // deterministic auto-assignment
};

function started(n = 3, t = 1000) {
  let state = createRoom({ code: "ABC123" });
  for (let i = 0; i < n; i++) state = addPlayer(state, { id: `p${i}`, nickname: `P${i}` }).state;
  return startGame(state, t, DEPS).state;
}

test("picking a club records it", () => {
  const res = pickClub(started(), { playerId: "p0", clubId: "Q1" }, 1100, DEPS);
  assert.equal(res.error, undefined);
  assert.equal(res.state.round.picks.p0, "Q1");
});

test("a club already taken is rejected", () => {
  let state = pickClub(started(), { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  const res = pickClub(state, { playerId: "p1", clubId: "Q1" }, 1200, DEPS);
  assert.equal(res.error, "club_taken");
  assert.equal(res.state.round.picks.p1, undefined);
});

test("a player may change their pick to a free club", () => {
  let state = pickClub(started(), { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  state = pickClub(state, { playerId: "p0", clubId: "Q2" }, 1200, DEPS).state;
  assert.equal(state.round.picks.p0, "Q2");
});

test("an unknown club id is rejected", () => {
  const res = pickClub(started(), { playerId: "p0", clubId: "Q999" }, 1100, DEPS);
  assert.equal(res.error, "unknown_club");
});

test("picking outside the PICKING phase is rejected", () => {
  const lobby = createRoom({ code: "ABC123" });
  assert.equal(pickClub(lobby, { playerId: "p0", clubId: "Q1" }, 1, DEPS).error, "wrong_phase");
});

test("the phase advances early once everyone has picked", () => {
  let state = started();
  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  state = pickClub(state, { playerId: "p1", clubId: "Q2" }, 1200, DEPS).state;
  assert.equal(state.phase, "PICKING", "still waiting on p2");
  state = pickClub(state, { playerId: "p2", clubId: "Q3" }, 1300, DEPS).state;
  assert.equal(state.phase, "ANSWERING", "all picked — advance without waiting out the clock");
  assert.equal(state.phaseEndsAt, 1300 + DEFAULT_CONFIG.answerSeconds * 1000);
});

test("expiry auto-assigns a club to anyone who did not pick", () => {
  let state = started();
  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  const res = expirePhase(state, 1000 + 15_000, DEPS);
  assert.equal(res.state.phase, "ANSWERING");
  // Every player must hold a distinct club so the round keeps its full size.
  const picks = Object.values(res.state.round.picks);
  assert.equal(picks.length, 3);
  assert.equal(new Set(picks).size, 3);
});

test("disconnected players are still assigned a club", () => {
  // Their club still counts toward the round, keeping the maximum score equal
  // to the player count.
  let state = started();
  state.players[2].connected = false;
  const res = expirePhase(state, 1000 + 15_000, DEPS);
  assert.equal(Object.keys(res.state.round.picks).length, 3);
});

test("expiry before the deadline does nothing", () => {
  const state = started();
  const res = expirePhase(state, 1001, DEPS);
  assert.equal(res.state.phase, "PICKING");
  assert.deepEqual(res.state.round.picks, {});
});
