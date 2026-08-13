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
  return state; // now ANSWERING, phaseEndsAt = t + 30s
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

test("grace lets a player answer after the phase deadline", () => {
  let state = submitAnswer(answering(2000), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  // p1 loses the race one second before time.
  state = submitAnswer(state, { playerId: "p1", entityId: "zlatan" }, 31_000, DEPS).state;
  // Deadline passes, but p1 is mid-grace so the phase must wait.
  const expired = expirePhase(state, 32_100, DEPS);
  assert.equal(expired.state.phase, "ANSWERING", "must not end while a player is in grace");
  const late = submitAnswer(expired.state, { playerId: "p1", entityId: "oneclub" }, 32_200, DEPS);
  assert.equal(late.error, undefined);
  assert.equal(late.state.round.answers.p1.entityId, "oneclub");
});

test("the phase ends once every grace window has lapsed", () => {
  let state = submitAnswer(answering(2000), { playerId: "p0", entityId: "zlatan" }, 2100, DEPS).state;
  state = submitAnswer(state, { playerId: "p1", entityId: "zlatan" }, 31_000, DEPS).state;
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
