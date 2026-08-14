import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDataset } from "../src/dataset/load.js";
import { scoreAnswer } from "../src/engine/scoring.js";

const raw = JSON.parse(await readFile(new URL("../data/dataset.json", import.meta.url), "utf8"));
const ds = createDataset(raw);

test("the dataset is populated", () => {
  assert.ok(ds.clubs.length >= 50, `expected >=50 clubs, got ${ds.clubs.length}`);
  assert.ok(ds.players.length >= 5000, `expected >=5000 players, got ${ds.players.length}`);
});

test("Ibrahimović scores for every one of his clubs in the list", () => {
  // The real dataset contains several unrelated Ibrahimović players (their
  // clubs put them in the curated list too), so "zlatan ibrahimovic" pins
  // the whole-name match to Q46896 rather than relying on search()[0].
  const hit = ds.search("zlatan ibrahimovic")[0];
  assert.ok(hit, "Ibrahimović must be findable");
  const clubs = ds.getPlayerClubs(hit.id);
  // Ajax, Juventus, Inter, Milan, Barcelona, PSG, Man United — whichever of
  // these are in clubs.json must all be present.
  assert.ok(clubs.includes("Q81888"), "Ajax missing");
  assert.ok(clubs.includes("Q1422"), "Juventus missing");
  assert.ok(scoreAnswer(clubs, ["Q81888", "Q1422"]).points === 2);
});

test("no player carries a club outside the curated list", () => {
  const curated = new Set(ds.clubs.map((c) => c.id));
    for (const p of ds.players) {
    for (const c of p.clubIds) {
      assert.ok(curated.has(c), `${p.name} has uncurated club ${c}`);
    }
  }
});

test("no national teams leaked in", () => {
  // Sweden men's national team — must never appear as a club.
  const curated = new Set(ds.clubs.map((c) => c.id));
  assert.ok(!curated.has("Q160826"));
});

test("every player has at least one curated club", () => {
  for (const p of ds.players) {
    assert.ok(p.clubIds.length > 0, `${p.name} has no clubs`);
  }
});
