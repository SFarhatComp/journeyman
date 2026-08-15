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

test("picking a club someone else already picked is allowed", () => {
  // Nobody can see the grid filling up, so rejecting this would punish a
  // player for information they were never given. It is settled at the end of
  // the phase instead.
  let state = pickClub(started(), { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  const res = pickClub(state, { playerId: "p1", clubId: "Q1" }, 1200, DEPS);
  assert.equal(res.error, undefined);
  assert.equal(res.state.round.picks.p1, "Q1");
});

test("a collision is settled by moving everyone but one to a free club", () => {
  let state = started();
  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  state = pickClub(state, { playerId: "p1", clubId: "Q1" }, 1200, DEPS).state;
  state = pickClub(state, { playerId: "p2", clubId: "Q2" }, 1300, DEPS).state;

  assert.equal(state.phase, "ANSWERING");
  const picks = Object.values(state.round.picks);
  assert.equal(new Set(picks).size, 3, "the round must still hold three distinct clubs");
  // random() is 0, so p0 keeps Q1 and p1 is moved to the first free club.
  assert.equal(state.round.picks.p0, "Q1");
  assert.equal(state.round.picks.p1, "Q3");
  assert.deepEqual(state.round.reassigned.p1, { from: "Q1", to: "Q3" });
  assert.equal(state.round.reassigned.p0, undefined, "the keeper was not moved");
});

test("a three-way collision moves two players, not one", () => {
  let state = started();
  for (const pid of ["p0", "p1", "p2"]) {
    state = pickClub(state, { playerId: pid, clubId: "Q1" }, 1100, DEPS).state;
  }
  assert.equal(state.phase, "ANSWERING");
  assert.equal(new Set(Object.values(state.round.picks)).size, 3);
  assert.equal(Object.keys(state.round.reassigned).length, 2);
});

test("collisions are also settled when the phase times out", () => {
  // The early-advance path and the expiry path must agree, or a round that
  // ran out of time could hand two players the same club.
  let state = started();
  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  state = pickClub(state, { playerId: "p1", clubId: "Q1" }, 1200, DEPS).state;
  const res = expirePhase(state, 1000 + DEFAULT_CONFIG.pickMaxSeconds * 1000, DEPS);

  assert.equal(res.state.phase, "ANSWERING");
  const picks = Object.values(res.state.round.picks);
  assert.equal(picks.length, 3, "p2 never picked and is auto-assigned");
  assert.equal(new Set(picks).size, 3, "auto-assignment must not reuse a reassigned club");
});

test("the pick clock only starts when one player is left to choose", () => {
  let state = started();
  assert.equal(state.round.pickTimerArmed, false);
  assert.equal(state.phaseEndsAt, 1000 + DEFAULT_CONFIG.pickMaxSeconds * 1000);

  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  assert.equal(state.round.pickTimerArmed, false, "two players are still deciding");

  const res = pickClub(state, { playerId: "p1", clubId: "Q2" }, 1200, DEPS);
  assert.equal(res.state.round.pickTimerArmed, true, "only p2 is left");
  assert.equal(res.state.phaseEndsAt, 1200 + DEFAULT_CONFIG.pickSeconds * 1000);
  assert.ok(res.events.some((e) => e.type === "pick_timer_armed"));
});

test("the pick clock is not pushed back by a player changing their mind", () => {
  let state = started();
  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  state = pickClub(state, { playerId: "p1", clubId: "Q2" }, 1200, DEPS).state;
  const armedAt = state.phaseEndsAt;

  state = pickClub(state, { playerId: "p0", clubId: "Q3" }, 1500, DEPS).state;
  assert.equal(state.phaseEndsAt, armedAt, "re-picking must not buy the room more time");
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
  assert.equal(state.phaseEndsAt, 1300 + DEFAULT_CONFIG.answerMaxSeconds * 1000, "backstop, not the visible clock");
});

test("expiry auto-assigns a club to anyone who did not pick", () => {
  let state = started();
  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, 1100, DEPS).state;
  const res = expirePhase(state, 1000 + DEFAULT_CONFIG.pickMaxSeconds * 1000, DEPS);
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
  const res = expirePhase(state, 1000 + DEFAULT_CONFIG.pickMaxSeconds * 1000, DEPS);
  assert.equal(Object.keys(res.state.round.picks).length, 3);
});

test("expiry before the deadline does nothing", () => {
  const state = started();
  const res = expirePhase(state, 1001, DEPS);
  assert.equal(res.state.phase, "PICKING");
  assert.deepEqual(res.state.round.picks, {});
});

test("picking-phase mutators do not touch the state they were given", () => {
  const base = started();
  const snapshot = structuredClone(base);

  pickClub(base, { playerId: "p0", clubId: "Q1" }, 1100, DEPS);
  assert.deepEqual(base, snapshot, "pickClub mutated its input");

  // Expiry runs resolveCollisions, autoAssign and beginAnswering, so this
  // covers all three helpers.
  expirePhase(base, 1000 + DEFAULT_CONFIG.pickMaxSeconds * 1000, DEPS);
  assert.deepEqual(base, snapshot, "expirePhase mutated its input");
});
