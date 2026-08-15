import test from "node:test";
import assert from "node:assert/strict";
import { createRoom, addPlayer, startGame, pickClub, submitAnswer, expirePhase, DEFAULT_CONFIG } from "../src/engine/room.js";

const DEPS = {
  clubs: [
    { id: "Q1", name: "Club One", country: "EN" },
    { id: "Q2", name: "Club Two", country: "ES" },
    { id: "Q3", name: "Club Three", country: "IT" },
  ],
  getPlayerClubs: (id) => ({ zlatan: ["Q1", "Q2", "Q3"], oneclub: ["Q1"] }[id] ?? []),
  findBest: () => ({ entityId: "zlatan", name: "Z. Ibrahimović", points: 3, matchedClubIds: ["Q1", "Q2", "Q3"] }),
  random: () => 0,
};

function answering(t = 2000) {
  let state = createRoom({ code: "ABC123" });
  for (let i = 0; i < 3; i++) state = addPlayer(state, { id: `p${i}`, nickname: `P${i}` }).state;
  state = startGame(state, 1000, DEPS).state;
  state = pickClub(state, { playerId: "p0", clubId: "Q1" }, t, DEPS).state;
  state = pickClub(state, { playerId: "p1", clubId: "Q2" }, t, DEPS).state;
  state = pickClub(state, { playerId: "p2", clubId: "Q3" }, t, DEPS).state;
  return state; // now ANSWERING, on the backstop until one player is left
}

test("an answer is recorded", () => {
  const res = submitAnswer(answering(), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS);
  assert.equal(res.error, undefined);
  assert.equal(res.state.round.answers.p0.entityId, "zlatan");
});

test("a footballer already claimed is rejected for the later player", () => {
  let state = submitAnswer(answering(), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  const res = submitAnswer(state, { playerId: "p1", entityId: "zlatan" }, 2200, DEPS);
  assert.equal(res.error, "already_claimed");
  assert.equal(res.state.round.answers.p1, undefined);
});

test("a rejected claim grants a personal grace extension", () => {
  let state = submitAnswer(answering(), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  const res = submitAnswer(state, { playerId: "p1", entityId: "zlatan" }, 2200, DEPS);
  assert.equal(res.state.round.grace.p1, 2200 + DEFAULT_CONFIG.graceSeconds * 1000);
});

// p0 and p2 answer, which arms the clock and leaves p1 as the last player.
// p1 then loses a race for zlatan and is put into grace. Both grace tests
// start from here, because a deadline that has not armed cannot expire, and
// asserting "still ANSWERING" against a phase that was never going to end
// would pass without testing anything.
function lastPlayerInGrace() {
  let state = submitAnswer(answering(2000), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  // "nobody", not "oneclub": p1 needs oneclub free to answer with after grace.
  state = submitAnswer(state, { playerId: "p2", entityId: "nobody" }, 2200, DEPS).state;
  return state;
}

test("the clock arms only when one player is left to answer", () => {
  let state = submitAnswer(answering(2000), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  assert.equal(state.round.answerTimerArmed, false, "two players are still thinking");
  assert.equal(state.phaseEndsAt, 2000 + DEFAULT_CONFIG.answerMaxSeconds * 1000, "backstop only");

  const res = submitAnswer(state, { playerId: "p2", entityId: "nobody" }, 2200, DEPS);
  assert.equal(res.state.round.answerTimerArmed, true, "only p1 is left");
  assert.equal(res.state.phaseEndsAt, 2200 + DEFAULT_CONFIG.answerSeconds * 1000);
  assert.ok(res.events.some((e) => e.type === "answer_timer_armed"));
});

test("losing a race does not start the clock on everyone else", () => {
  // A rejected answer never reaches the arming branch. If it did, being beaten
  // to a footballer would put the whole room on a countdown.
  let state = submitAnswer(answering(2000), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  const res = submitAnswer(state, { playerId: "p1", entityId: "zlatan" }, 2200, DEPS);
  assert.equal(res.error, "already_claimed");
  assert.equal(res.state.round.answerTimerArmed, false);
  assert.equal(res.state.phaseEndsAt, 2000 + DEFAULT_CONFIG.answerMaxSeconds * 1000, "unchanged");
});

test("grace lets a player answer after the phase deadline", () => {
  // Armed at 2200, so the deadline is 32_200. p1 loses the race just before.
  let state = submitAnswer(lastPlayerInGrace(), { playerId: "p1", entityId: "zlatan" }, 31_000, DEPS).state;
  // Deadline passes, but p1 is mid-grace so the phase must wait.
  const expired = expirePhase(state, 32_300, DEPS);
  assert.equal(expired.state.phase, "ANSWERING", "must not end while a player is in grace");
  const late = submitAnswer(expired.state, { playerId: "p1", entityId: "oneclub" }, 32_400, DEPS);
  assert.equal(late.error, undefined);
  assert.equal(late.state.round.answers.p1.entityId, "oneclub");
});

test("the phase ends once every grace window has lapsed", () => {
  let state = submitAnswer(lastPlayerInGrace(), { playerId: "p1", entityId: "zlatan" }, 31_000, DEPS).state;
  const expired = expirePhase(state, 36_001, DEPS); // grace ended at 36_000
  assert.equal(expired.state.phase, "REVEAL");
});

test("a player may not answer twice", () => {
  let state = submitAnswer(answering(), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  const res = submitAnswer(state, { playerId: "p0", entityId: "oneclub" }, 2200, DEPS);
  assert.equal(res.error, "already_answered");
});

test("answering advances early once everyone has answered", () => {
  let state = answering();
  state = submitAnswer(state, { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  state = submitAnswer(state, { playerId: "p1", entityId: "oneclub" }, 2200, DEPS).state;
  assert.equal(state.phase, "ANSWERING");
  state = submitAnswer(state, { playerId: "p2", entityId: "nobody" }, 2300, DEPS).state;
  assert.equal(state.phase, "REVEAL");
});

test("answering outside the phase is rejected", () => {
  const lobby = createRoom({ code: "ABC123" });
  assert.equal(submitAnswer(lobby, { playerId: "p0", entityId: "x" }, 1, DEPS).error, "wrong_phase");
});

test("submitAnswer leaves its input untouched on both the accept and reject paths", () => {
  const base = answering();
  const baseSnapshot = structuredClone(base);
  submitAnswer(base, { playerId: "p0", entityId: "zlatan" }, 2100, DEPS);
  assert.deepEqual(base, baseSnapshot, "submitAnswer mutated its input when accepting");

  // The rejected-claim path takes a different branch and writes to grace.
  const claimed = submitAnswer(base, { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  const claimedSnapshot = structuredClone(claimed);
  submitAnswer(claimed, { playerId: "p1", entityId: "zlatan" }, 2200, DEPS);
  assert.deepEqual(claimed, claimedSnapshot, "submitAnswer mutated its input when rejecting a claim");
});
