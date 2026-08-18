import test from "node:test";
import assert from "node:assert/strict";
import { shapeDataset } from "../src/dataset/fromWikidata.js";

const CLUBS = [
  { id: "Q81888", name: "AFC Ajax", country: "NL" },
  { id: "Q1422", name: "Juventus FC", country: "IT" },
];

const row = (pid, name, club, dob, iso) => ({
  player: { value: `http://www.wikidata.org/entity/${pid}` },
  playerLabel: { value: name },
  club: { value: `http://www.wikidata.org/entity/${club}` },
  ...(dob ? { dob: { value: dob } } : {}),
  ...(iso ? { iso: { value: iso } } : {}),
});

test("rows collapse into one player carrying all their clubs", () => {
  const out = shapeDataset(CLUBS, [
    row("Q46896", "Zlatan Ibrahimović", "Q81888", "1981-10-03T00:00:00Z"),
    row("Q46896", "Zlatan Ibrahimović", "Q1422", "1981-10-03T00:00:00Z"),
  ]);
  assert.equal(out.players.length, 1);
  assert.deepEqual(out.players[0].clubIds, ["Q1422", "Q81888"]);
  assert.equal(out.players[0].birthYear, 1981);
});

test("clubs outside the curated list are dropped", () => {
  // This is what keeps national teams out and sidesteps Wikidata's unreliable
  // club typing — FC Barcelona is not typed as an association football club.
  const out = shapeDataset(CLUBS, [
    row("Q46896", "Zlatan Ibrahimović", "Q81888"),
    row("Q46896", "Zlatan Ibrahimović", "Q160826"), // Sweden national team
  ]);
  assert.deepEqual(out.players[0].clubIds, ["Q81888"]);
});

test("a player left with no curated clubs is dropped entirely", () => {
  const out = shapeDataset(CLUBS, [row("Q1", "Nobody", "Q999999")]);
  assert.deepEqual(out.players, []);
});

test("repeated spells at one club collapse to a single entry", () => {
  const out = shapeDataset(CLUBS, [
    row("Q46896", "Zlatan Ibrahimović", "Q1422"),
    row("Q46896", "Zlatan Ibrahimović", "Q1422"),
  ]);
  assert.deepEqual(out.players[0].clubIds, ["Q1422"]);
});

test("a missing date of birth yields no birthYear rather than NaN", () => {
  const out = shapeDataset(CLUBS, [row("Q1", "No Birthday", "Q1422")]);
  assert.equal(out.players[0].birthYear, undefined);
});

test("country of citizenship is carried through as an ISO code", () => {
  const out = shapeDataset(CLUBS, [
    row("Q46896", "Zlatan Ibrahimović", "Q1422", "1981-10-03T00:00:00Z", "SE"),
  ]);
  assert.equal(out.players[0].country, "SE");
});

test("dual citizenship resolves deterministically to one code", () => {
  // Wikidata returns a row per citizenship; the label must not flap between
  // runs, so the first alphabetically wins.
  const rows = [
    row("Q1", "Dual National", "Q1422", undefined, "MA"),
    row("Q1", "Dual National", "Q1422", undefined, "FR"),
  ];
  const a = shapeDataset(CLUBS, rows).players[0].country;
  const b = shapeDataset(CLUBS, [...rows].reverse()).players[0].country;
  assert.equal(a, "FR");
  assert.equal(a, b);
});

test("a missing country yields no country rather than undefined text", () => {
  const out = shapeDataset(CLUBS, [row("Q1", "Stateless", "Q1422")]);
  assert.equal(out.players[0].country, undefined);
});

test("rows whose label is a bare QID are dropped as unlabelled", () => {
  // Wikidata returns the QID as the label when no English label exists.
  const out = shapeDataset(CLUBS, [row("Q12345", "Q12345", "Q1422")]);
  assert.deepEqual(out.players, []);
});

test("the curated club list is passed through unchanged", () => {
  const out = shapeDataset(CLUBS, []);
  assert.deepEqual(out.clubs, CLUBS);
});

test("output is deterministic regardless of row order", () => {
  const rows = [
    row("Q2", "Bee Player", "Q1422"),
    row("Q1", "Ay Player", "Q81888"),
  ];
  const a = shapeDataset(CLUBS, rows);
  const b = shapeDataset(CLUBS, [...rows].reverse());
  assert.deepEqual(a, b);
});

// The file already has a positional `row` helper; this one takes overrides,
// because these tests care about which naming fields are present.
const namingRow = (over = {}) => ({
  player: { value: "http://www.wikidata.org/entity/Q483837" },
  club: { value: "http://www.wikidata.org/entity/Q1" },
  ...over,
});

test("a player with no English label is named from their article", () => {
  // Luka Modrić carries 59 labels on Wikidata and not one of them is English,
  // so he was dropped as unnameable — invisible in a football game — while
  // the article about him sits there titled "Luka Modrić".
  const { players } = shapeDataset(
    [{ id: "Q1", name: "Club One", country: "EN" }],
    [namingRow({ playerLabel: { value: "Q483837" } })], // Wikidata echoes the id back
    new Map([["Q483837", "Luka Modrić"]]),
  );
  assert.equal(players.length, 1);
  assert.equal(players[0].name, "Luka Modrić");
});

test("an English label still wins over the article title", () => {
  // Article titles carry disambiguators and different conventions; the label
  // is the better name whenever there is one.
  const { players } = shapeDataset(
    [{ id: "Q1", name: "Club One", country: "EN" }],
    [namingRow({ playerLabel: { value: "Kevin De Bruyne" } })],
    new Map([["Q483837", "Kevin De Bruyne (footballer)"]]),
  );
  assert.equal(players[0].name, "Kevin De Bruyne");
});

test("the article's disambiguator is not part of the name", () => {
  const { players } = shapeDataset(
    [{ id: "Q1", name: "Club One", country: "EN" }],
    [namingRow({ playerLabel: { value: "Q483837" } })],
    new Map([["Q483837", "John Smith (footballer, born 1990)"]]),
  );
  assert.equal(players[0].name, "John Smith");
});

test("no label and no article means there is nothing to call them", () => {
  // Keeping them would put a bare QID in the autocomplete.
  const { players } = shapeDataset(
    [{ id: "Q1", name: "Club One", country: "EN" }],
    [namingRow({ playerLabel: { value: "Q483837" } })],
  );
  assert.deepEqual(players, []);
});
