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

test("an exact word beats a longer name that merely starts with the query", () => {
  // Typing "messi" returned Messias Timula, Danilo Messina and Junior Messias
  // before Lionel Messi: they sort earlier alphabetically and all four were
  // treated as equally good matches.
  const ds = createDataset({
    clubs: [],
    players: [
      { id: "TIMULA", name: "Messias Timula", birthYear: 1948, country: "PT", clubIds: ["Q1"] },
      { id: "MESSINA", name: "Danilo Messina", birthYear: 1992, country: "IT", clubIds: ["Q1"] },
      { id: "MESSIAS", name: "Junior Messias", birthYear: 1991, country: "BR", clubIds: ["Q1"] },
      { id: "MESSI", name: "Lionel Messi", birthYear: 1987, country: "AR", clubIds: ["Q1"] },
    ],
  });
  assert.equal(ds.search("messi")[0].id, "MESSI", "the exact surname must win");
});

test("within a tier the player in more of this game's clubs comes first", () => {
  // Both are exactly "Zlatan". Nothing in a name says which one anyone meant,
  // but appearing in eight of the ninety-seven clubs the game is played with
  // is a strong signal, and alphabetical order is none at all.
  const ds = createDataset({
    clubs: [],
    players: [
      { id: "ALO", name: "Zlatan Alomerovic", birthYear: 1991, country: "DE", clubIds: ["Q1"] },
      { id: "IBRA", name: "Zlatan Ibrahimovic", birthYear: 1981, country: "SE",
        clubIds: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"] },
    ],
  });
  assert.equal(ds.search("zlatan")[0].id, "IBRA");
});

test("an exact full name outranks an exact word", () => {
  const ds = createDataset({
    clubs: [],
    players: [
      { id: "WORD", name: "Ronaldo Nazario", birthYear: 1976, country: "BR", clubIds: ["Q1", "Q2", "Q3"] },
      { id: "FULL", name: "Ronaldo", birthYear: 1985, country: "PT", clubIds: ["Q1"] },
    ],
  });
  assert.equal(ds.search("ronaldo")[0].id, "FULL", "even with fewer clubs, the whole name is the better match");
});

test("a surname typed with its particle finds the player", () => {
  // "dijk" worked and "van dijk" found nobody, because every tier matched only
  // a prefix — of the whole name or of one word — and his name starts with
  // "Virgil". Same for "de bruyne". This is how people actually type.
  const ds = createDataset({
    clubs: [],
    players: [
      { id: "VVD", name: "Virgil van Dijk", birthYear: 1991, country: "NL", clubIds: ["Q1"] },
      { id: "KDB", name: "Kevin De Bruyne", birthYear: 1991, country: "BE", clubIds: ["Q1"] },
      { id: "RVP", name: "Robin van Persie", birthYear: 1983, country: "NL", clubIds: ["Q1"] },
    ],
  });
  assert.equal(ds.search("van dijk")[0].id, "VVD");
  assert.equal(ds.search("de bruyne")[0].id, "KDB");
  assert.equal(ds.search("van persie")[0].id, "RVP");
});

test("a surname typed as one word finds the player too", () => {
  // Nobody reliably remembers whether it is "de Bruyne" or "Debruyne".
  const ds = createDataset({
    clubs: [],
    players: [
      { id: "VVD", name: "Virgil van Dijk", birthYear: 1991, country: "NL", clubIds: ["Q1"] },
      { id: "KDB", name: "Kevin De Bruyne", birthYear: 1991, country: "BE", clubIds: ["Q1"] },
    ],
  });
  assert.equal(ds.search("vandijk")[0].id, "VVD");
  assert.equal(ds.search("debruyne")[0].id, "KDB");
});

test("an exact match still outranks a loose one", () => {
  // The new tiers must not drown the good matches they sit behind.
  const ds = createDataset({
    clubs: [],
    players: [
      { id: "LOOSE", name: "Someone Vandijkstra", birthYear: 1990, country: "NL", clubIds: ["Q1", "Q2"] },
      { id: "VVD", name: "Virgil van Dijk", birthYear: 1991, country: "NL", clubIds: ["Q1"] },
    ],
  });
  assert.equal(ds.search("van dijk")[0].id, "VVD", "the real name must come first");
});
