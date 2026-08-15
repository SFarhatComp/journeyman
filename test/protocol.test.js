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

test("valid JSON that is not an object is rejected without throwing", () => {
  // msg?.type is undefined for all of these, so the validator lookup misses.
  for (const raw of ["null", "123", "[]", '"a string"']) {
    assert.equal(parseMessage(raw).error, "unknown_type", `${raw} should be rejected`);
  }
});

test("an unknown message type is rejected", () => {
  assert.equal(parseMessage(JSON.stringify({ type: "dropTable" })).error, "unknown_type");
});

test("an oversized message is rejected before it is parsed", () => {
  // Deliberately BOTH oversized and malformed: an implementation that parsed
  // first would return bad_json, so this asserts the ordering rather than
  // merely that both checks exist.
  const big = "{" + "x".repeat(MAX_MESSAGE_BYTES);
  assert.equal(parseMessage(big).error, "too_large");
});

test("a nickname longer than 24 characters is rejected", () => {
  const r = parseMessage(JSON.stringify({ type: "join", payload: { nickname: "x".repeat(25) } }));
  assert.equal(r.error, "bad_payload");
});

test("an empty nickname is rejected", () => {
  assert.equal(parseMessage(JSON.stringify({ type: "join", payload: { nickname: "  " } })).error, "bad_payload");
});

const answeringWith = (answers) => ({
  phase: "ANSWERING", code: "ABC123", config: {}, phaseEndsAt: 5000,
  players: [{ id: "p0", nickname: "A", score: 0, connected: true },
            { id: "p1", nickname: "B", score: 0, connected: true }],
  round: { number: 1, picks: { p0: "Q1", p1: "Q2" }, answers, grace: {}, results: null, bestAnswer: null },
});

test("claimed footballers are public as they are claimed", () => {
  // This used to be hidden, to stop anyone copying a rival. But a footballer
  // already claimed is rejected outright, so copying was never possible —
  // hiding it only made people find out by wasting a guess.
  const snap = snapshotFor(
    answeringWith({ p1: { entityId: "zlatan", entityLabel: "Z. Ibrahimović (1981, SE)" } }), "p0");

  assert.equal(snap.round.answered.p1, true);
  assert.equal(snap.round.claimed.p1, "Z. Ibrahimović (1981, SE)");
  assert.equal(snap.round.claimed.p0, undefined, "p0 has not answered");
});

test("the raw answer records never reach a client", () => {
  // The label is public; submittedAt and the entity id are not, because
  // nothing on screen needs them and an id is a handle for guessing.
  const snap = snapshotFor(
    answeringWith({ p1: { entityId: "zlatan", entityLabel: "Z. Ibrahimović (1981, SE)" } }), "p0");
  assert.equal(snap.round.answers, undefined);
  assert.equal(JSON.stringify(snap).includes("submittedAt"), false);
});

test("an answer with no resolvable label shows as null, never as a raw id", () => {
  const snap = snapshotFor(answeringWith({ p1: { entityId: "Q999", entityLabel: null } }), "p0");
  assert.equal(snap.round.claimed.p1, null);
  assert.equal(JSON.stringify(snap).includes("Q999"), false);
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

test("a player sees their own grace deadline and not another player's", () => {
  const state = {
    phase: "ANSWERING", code: "ABC123", config: {}, phaseEndsAt: 5000,
    players: [
      { id: "p0", nickname: "A", score: 0, connected: true },
      { id: "p1", nickname: "B", score: 0, connected: true },
    ],
    round: {
      number: 1, picks: {}, answers: {},
      grace: { p0: 7000, p1: 9999 },
      results: null, bestAnswer: null,
    },
  };

  assert.equal(snapshotFor(state, "p0").round.myGraceEndsAt, 7000);
  assert.equal(snapshotFor(state, "p1").round.myGraceEndsAt, 9999, "must be keyed by the requesting player");
});

const picking = (round) => ({
  phase: "PICKING", code: "ABC123", config: {}, phaseEndsAt: 60_000,
  players: [{ id: "p0", nickname: "A", score: 0, connected: true },
            { id: "p1", nickname: "B", score: 0, connected: true }],
  round: { number: 1, answers: {}, grace: {}, reassigned: {}, pickTimerArmed: false,
           results: null, bestAnswer: null, ...round },
});

test("the snapshot hides other players' club picks while picking", () => {
  // Watching the grid fill up turns choosing into reacting to everyone else,
  // which is the whole reason picks are hidden.
  const snap = snapshotFor(picking({ picks: { p0: "Q1", p1: "Q2" } }), "p0");
  assert.deepEqual(snap.round.picks, { p0: "Q1" }, "own pick only");
});

test("a player who has not picked sees no picks at all", () => {
  const snap = snapshotFor(picking({ picks: { p1: "Q2" } }), "p0");
  assert.deepEqual(snap.round.picks, {});
});

test("the picking snapshot says how many have chosen, not who or what", () => {
  const snap = snapshotFor(picking({ picks: { p0: "Q1", p1: "Q2" } }), "p0");
  assert.equal(snap.round.pickedCount, 2);
});

test("every pick becomes public once the round is under way", () => {
  // From ANSWERING on, the set of clubs IS the round — hiding it would hide
  // the question being asked.
  const state = { ...picking({ picks: { p0: "Q1", p1: "Q2" } }), phase: "ANSWERING" };
  assert.deepEqual(snapshotFor(state, "p0").round.picks, { p0: "Q1", p1: "Q2" });
});

test("the picking deadline is withheld until the clock actually arms", () => {
  // The backstop exists so an abandoned room cannot hang forever. Showing it
  // would put a 60-second countdown on screen that means nothing.
  assert.equal(snapshotFor(picking({ picks: {} }), "p0").phaseEndsAt, null);

  const armed = picking({ picks: { p0: "Q1" }, pickTimerArmed: true });
  assert.equal(snapshotFor(armed, "p0").phaseEndsAt, 60_000);
});

test("a player is told about their own collision and nobody else's", () => {
  const state = picking({
    picks: { p0: "Q3", p1: "Q1" },
    reassigned: { p0: { from: "Q1", to: "Q3" } },
  });
  assert.deepEqual(snapshotFor(state, "p0").round.myReassignment, { from: "Q1", to: "Q3" });
  // Telling p1 that p0 was moved off Q1 would leak that p1 holds Q1.
  assert.equal(snapshotFor(state, "p1").round.myReassignment, null);
});

test("footballers named in finished rounds are listed for everyone", () => {
  // Those were revealed when their round ended, so republishing them leaks
  // nothing — it stops people burning a guess on a name already used.
  const state = {
    ...picking({ picks: { p0: "Q1" } }),
    history: [
      { number: 1, results: [{ entityLabel: "Z. Ibrahimović (1981, SE)" }, { entityLabel: null }] },
      { number: 2, results: [{ entityLabel: "X. Hernández (1980, ES)" }] },
    ],
  };
  assert.deepEqual(snapshotFor(state, "p0").namedSoFar,
    ["Z. Ibrahimović (1981, SE)", "X. Hernández (1980, ES)"]);
});

test("a player who never answered contributes no name", () => {
  // Their result carries a null label, which must not reach the list as a gap.
  const state = { ...picking({ picks: {} }), history: [{ number: 1, results: [{ entityLabel: null }] }] };
  assert.deepEqual(snapshotFor(state, "p0").namedSoFar, []);
});

test("the first round has nothing named yet", () => {
  assert.deepEqual(snapshotFor(picking({ picks: {} }), "p0").namedSoFar, []);
});
