import test from "node:test";
import assert from "node:assert/strict";
import { parseMessage, snapshotFor, MAX_MESSAGE_BYTES } from "../src/protocol.js";

test("a valid message parses", () => {
  const r = parseMessage(JSON.stringify({ type: "pickClub", payload: { clubId: "Q1" } }));
  assert.equal(r.type, "pickClub");
  assert.deepEqual(r.payload, { clubId: "Q1" });
});

test("malformed JSON is rejected, not thrown", () => {
  assert.equal(parseMessage("{not json").error, "bad_json");
});

test("an unknown message type is rejected", () => {
  assert.equal(parseMessage(JSON.stringify({ type: "dropTable" })).error, "unknown_type");
});

test("an oversized message is rejected before parsing", () => {
  const big = JSON.stringify({ type: "join", payload: { nickname: "x".repeat(MAX_MESSAGE_BYTES) } });
  assert.equal(parseMessage(big).error, "too_large");
});

test("a nickname longer than 24 characters is rejected", () => {
  const r = parseMessage(JSON.stringify({ type: "join", payload: { nickname: "x".repeat(25) } }));
  assert.equal(r.error, "bad_payload");
});

test("an empty nickname is rejected", () => {
  assert.equal(parseMessage(JSON.stringify({ type: "join", payload: { nickname: "  " } })).error, "bad_payload");
});

test("the snapshot hides other players' answers during ANSWERING", () => {
  // Seeing what someone else typed would let you copy it or dodge their claim.
  const state = {
    phase: "ANSWERING", code: "ABC123", config: {}, phaseEndsAt: 5000,
    players: [{ id: "p0", nickname: "A", score: 0, connected: true },
              { id: "p1", nickname: "B", score: 0, connected: true }],
    round: { number: 1, picks: { p0: "Q1", p1: "Q2" }, answers: { p1: { entityId: "zlatan" } }, grace: {}, results: null, bestAnswer: null },
  };
  const snap = snapshotFor(state, "p0");
  assert.equal(snap.round.answered.p1, true, "you may know THAT they answered");
  assert.equal(snap.round.answers, undefined, "but never WHAT they answered");
});

test("the snapshot reveals everything at REVEAL", () => {
  const state = {
    phase: "REVEAL", code: "ABC123", config: {}, phaseEndsAt: 9000,
    players: [{ id: "p0", nickname: "A", score: 3, connected: true }],
    round: { number: 1, picks: { p0: "Q1" }, answers: { p0: { entityId: "zlatan" } }, grace: {},
             results: [{ playerId: "p0", entityId: "zlatan", points: 3, matchedClubIds: ["Q1"] }],
             bestAnswer: { entityId: "zlatan", name: "Z. Ibrahimović", points: 3 } },
  };
  const snap = snapshotFor(state, "p0");
  assert.equal(snap.round.results.length, 1);
  assert.equal(snap.round.bestAnswer.points, 3);
});

test("the snapshot tells a player about their own grace window", () => {
  const state = {
    phase: "ANSWERING", code: "ABC123", config: {}, phaseEndsAt: 5000,
    players: [{ id: "p0", nickname: "A", score: 0, connected: true }],
    round: { number: 1, picks: {}, answers: {}, grace: { p0: 7000 }, results: null, bestAnswer: null },
  };
  assert.equal(snapshotFor(state, "p0").round.myGraceEndsAt, 7000);
});
