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
    { id: "Q3", name: "Jose Gomez", birthYear: 1990, country: "ES", clubIds: ["Q1422"] },
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

test("a whole-name match outranks a word match regardless of data order", () => {
  const ds = createDataset({
    clubs: [],
    players: [
      // Interior-word match, listed FIRST…
      { id: "Q1", name: "Thiago Silva", birthYear: 1984, country: "BR", clubIds: [] },
      // …whole-name match, listed LAST. Order in the data must not decide rank.
      { id: "Q2", name: "Silva Martins", birthYear: 1990, country: "PT", clubIds: [] },
    ],
  });
  assert.equal(ds.search("silva")[0].id, "Q2", "whole-name prefix must come first");
});

test("a whole-name match is not lost behind many word matches", () => {
  // Regression test: the scan used to stop after limit*4 hits BEFORE sorting,
  // so enough interior-word matches ahead of the true prefix match pushed it
  // out of the results entirely.
  const players = [];
  for (let i = 0; i < 40; i++) {
    players.push({ id: `W${i}`, name: `Player Dasilva${i}`, birthYear: 1990, country: "BR", clubIds: [] });
  }
  players.push({ id: "TARGET", name: "Dasilva Junior", birthYear: 1995, country: "BR", clubIds: [] });

  const ds = createDataset({ clubs: [], players });
  assert.equal(ds.search("dasilva")[0].id, "TARGET", "the whole-name match must survive the limit");
});

test("search strips accents from the query, not just the data", () => {
  // Deleting the diacritic strip from normalize() must turn this red: NFD
  // decomposition alone leaves a combining mark on the query, which then
  // fails to prefix-match the plainly-spelled name.
  const ds = createDataset(FIXTURE);
  assert.equal(ds.search("josé")[0].id, "Q3");
});
