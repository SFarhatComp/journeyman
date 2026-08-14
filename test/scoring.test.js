import test from "node:test";
import assert from "node:assert/strict";
import { scoreAnswer, findBestAnswer } from "../src/engine/scoring.js";

test("points equal the number of round clubs the footballer played for", () => {
  const r = scoreAnswer(["Q81888", "Q1422", "Q631"], ["Q1422", "Q631", "Q7156"]);
  assert.equal(r.points, 2);
  assert.deepEqual(r.matchedClubIds.sort(), ["Q1422", "Q631"]);
});

test("a footballer sharing no clubs with the round scores zero", () => {
  const r = scoreAnswer(["Q9999"], ["Q1422", "Q631"]);
  assert.equal(r.points, 0);
  assert.deepEqual(r.matchedClubIds, []);
});

test("clubs outside the round never count, however many the player has", () => {
  // The most-travelled journeyman scores 1 if only one of his clubs is in play.
  const many = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"];
  assert.equal(scoreAnswer(many, ["Q7", "Q99"]).points, 1);
});

test("duplicate club ids on a player cannot double-count", () => {
  // Two spells at one club (Ibrahimović had two at Milan) is one club.
  assert.equal(scoreAnswer(["Q1543", "Q1543"], ["Q1543"]).points, 1);
});

test("findBestAnswer returns the highest-scoring player in the dataset", () => {
  const players = [
    { id: "A", name: "One Club", clubIds: ["Q1"] },
    { id: "B", name: "Journeyman", clubIds: ["Q1", "Q2", "Q3"] },
    { id: "C", name: "Two Clubs", clubIds: ["Q1", "Q2"] },
  ];
  const best = findBestAnswer(["Q1", "Q2", "Q3"], players);
  assert.equal(best.entityId, "B");
  assert.equal(best.points, 3);
});

test("findBestAnswer returns null when nobody matches", () => {
  const players = [{ id: "A", name: "One Club", clubIds: ["Q1"] }];
  assert.equal(findBestAnswer(["Q99"], players), null);
});
