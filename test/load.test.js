import test from "node:test";
import assert from "node:assert/strict";
import { createDataset } from "../src/dataset/load.js";

const FIXTURE = {
  clubs: [
    { id: "Q81888", name: "AFC Ajax", country: "NL" },
    { id: "Q1422", name: "Juventus FC", country: "IT" },
  ],
  players: [
    { id: "Q46896", name: "Zlatan Ibrahimović", birthYear: 1981, country: "SE", clubIds: ["Q81888", "Q1422"] },
    { id: "Q1", name: "Danny Blind", birthYear: 1961, country: "NL", clubIds: ["Q81888"] },
    { id: "Q2", name: "Daley Blind", birthYear: 1990, country: "NL", clubIds: ["Q81888"] },
  ],
};

test("search matches on surname", () => {
  const ds = createDataset(FIXTURE);
  const ids = ds.search("blind").map((r) => r.id).sort();
  assert.deepEqual(ids, ["Q1", "Q2"]);
});

test("search ignores accents so a phone keyboard can find the name", () => {
  const ds = createDataset(FIXTURE);
  // "Ibrahimovic" must find "Ibrahimović".
  assert.equal(ds.search("ibrahimovic")[0].id, "Q46896");
});

test("search is case-insensitive and matches any word, not just the first", () => {
  const ds = createDataset(FIXTURE);
  assert.equal(ds.search("ZLATAN")[0].id, "Q46896");
  assert.equal(ds.search("Ibra")[0].id, "Q46896");
});

test("search results carry uniform labels", () => {
  const ds = createDataset(FIXTURE);
  const labels = ds.search("blind").map((r) => r.label).sort();
  assert.deepEqual(labels, ["D. Blind (1961, NL)", "D. Blind (1990, NL)"]);
});

test("search results never contain club names", () => {
  const ds = createDataset(FIXTURE);
  for (const r of ds.search("blind")) {
    assert.doesNotMatch(r.label, /Ajax|Juventus|Q\d+/i);
  }
});

test("search respects the result limit", () => {
  const ds = createDataset(FIXTURE);
  assert.equal(ds.search("blind", 1).length, 1);
});

test("a query shorter than two characters returns nothing", () => {
  const ds = createDataset(FIXTURE);
  assert.deepEqual(ds.search("b"), []);
});

test("getPlayerClubs returns the club ids for scoring", () => {
  const ds = createDataset(FIXTURE);
  assert.deepEqual(ds.getPlayerClubs("Q46896").sort(), ["Q1422", "Q81888"]);
});

test("getPlayerClubs on an unknown id returns an empty list", () => {
  const ds = createDataset(FIXTURE);
  assert.deepEqual(ds.getPlayerClubs("Q999"), []);
});
