import test from "node:test";
import assert from "node:assert/strict";
import {
  createRoom,
  addPlayer,
  startGame,
  pickClub,
  submitAnswer,
  expirePhase,
  disconnect,
  beginReveal,
} from "../src/engine/room.js";

const CAREERS = {
  zlatan: ["Q1", "Q2", "Q3"],
  twoclub: ["Q1", "Q2"],
  oneclub: ["Q1"],
  nobody: [],
  // Two separate spells at Q1, as Ibrahimović had at Milan. Still one club.
  tworeturns: ["Q1", "Q1", "Q2"],
};
const DEPS = {
  clubs: [
    { id: "Q1", name: "Club One", country: "EN" },
    { id: "Q2", name: "Club Two", country: "ES" },
    { id: "Q3", name: "Club Three", country: "IT" },
  ],
  getPlayerClubs: (id) => CAREERS[id] ?? [],
  findBest: () => ({ entityId: "zlatan", name: "Z. Ibrahimović", points: 3, matchedClubIds: ["Q1", "Q2", "Q3"] }),
  random: () => 0,
};

function revealed(answers, config = {}) {
  let state = createRoom({ code: "ABC123", config });
  for (let i = 0; i < 3; i++) state = addPlayer(state, { id: `p${i}`, nickname: `P${i}` }).state;
  state = startGame(state, 1000, DEPS).state;
  ["Q1", "Q2", "Q3"].forEach((c, i) => {
    state = pickClub(state, { playerId: `p${i}`, clubId: c }, 2000, DEPS).state;
  });
  answers.forEach((entityId, i) => {
    state = submitAnswer(state, { playerId: `p${i}`, entityId }, 2100 + i, DEPS).state;
  });
  return state;
}

test("scores equal the clubs matched from the round", () => {
  const state = revealed(["zlatan", "twoclub", "oneclub"]);
  assert.equal(state.phase, "REVEAL");
  const score = (id) => state.players.find((p) => p.id === id).score;
  assert.equal(score("p0"), 3);
  assert.equal(score("p1"), 2);
  assert.equal(score("p2"), 1);
});

test("a footballer with none of the round's clubs scores zero", () => {
  const state = revealed(["nobody", "oneclub", "twoclub"]);
  assert.equal(state.players.find((p) => p.id === "p0").score, 0);
});

test("results list each answer with the clubs it matched", () => {
  const state = revealed(["twoclub", "oneclub", "nobody"]);
  const r = state.round.results.find((x) => x.playerId === "p0");
  assert.equal(r.points, 2);
  assert.deepEqual(r.matchedClubIds.sort(), ["Q1", "Q2"]);
});

test("the best possible answer is attached to the round", () => {
  const state = revealed(["oneclub", "nobody", "nobody2"]);
  assert.equal(state.round.bestAnswer.entityId, "zlatan");
  assert.equal(state.round.bestAnswer.points, 3);
});

test("a player who never answered scores zero and is listed", () => {
  let state = revealed(["zlatan", "oneclub"]); // p2 never answers
  state = expirePhase(state, 1000 + 15_000 + 30_000 + 1, DEPS).state;
  const r = state.round.results.find((x) => x.playerId === "p2");
  assert.equal(r.points, 0);
  assert.equal(r.entityId, null);
});

test("scores accumulate across rounds", () => {
  let state = revealed(["twoclub", "oneclub", "nobody"]);
  state = expirePhase(state, state.phaseEndsAt, DEPS).state; // REVEAL -> round 2
  assert.equal(state.phase, "PICKING");
  assert.equal(state.round.number, 2);
  assert.equal(state.players.find((p) => p.id === "p0").score, 2, "carried forward");
});

test("the game ends after the configured number of rounds", () => {
  let state = revealed(["zlatan", "oneclub", "nobody"], { rounds: 1 });
  state = expirePhase(state, state.phaseEndsAt, DEPS).state;
  assert.equal(state.phase, "FINAL");
});

test("the final standings are sorted by score", () => {
  let state = revealed(["oneclub", "zlatan", "twoclub"], { rounds: 1 });
  state = expirePhase(state, state.phaseEndsAt, DEPS).state;
  assert.deepEqual(state.standings.map((p) => p.id), ["p1", "p2", "p0"]);
});

test("two spells at one club count once", () => {
  // A raw filter over the career array would score 3 here and return
  // ["Q1","Q1","Q2"] — the dedup is what makes it 2.
  const state = revealed(["tworeturns", "oneclub", "nobody"]);
  const r = state.round.results.find((x) => x.playerId === "p0");

  assert.equal(r.points, 2, "Q1 twice plus Q2 is two clubs, not three");
  assert.deepEqual(r.matchedClubIds.sort(), ["Q1", "Q2"]);
});

test("disconnecting keeps the score and marks the player offline", () => {
  let state = revealed(["zlatan", "oneclub", "nobody"]);
  const res = disconnect(state, "p0");
  const p0 = res.state.players.find((p) => p.id === "p0");
  assert.equal(p0.connected, false);
  assert.equal(p0.score, 3, "score is retained");
});

test("every exported mutator leaves the state it was given untouched", () => {
  // The engine's purity rule is load-bearing: the server holds room state and
  // relies on snapshots not changing underfoot. Three mutate-in-place bugs
  // shipped during this build and were caught by review, not by tests. This
  // is that missing net — making any of these mutate must turn it red.
  const base = revealed(["twoclub", "oneclub", "nobody"]);
  const snapshot = structuredClone(base);

  beginReveal(base, 9000, DEPS);
  assert.deepEqual(base, snapshot, "beginReveal mutated its input");

  disconnect(base, "p0");
  assert.deepEqual(base, snapshot, "disconnect mutated its input");

  expirePhase(base, 999_999, DEPS);
  assert.deepEqual(base, snapshot, "expirePhase mutated its input");
});
