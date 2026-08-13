import test from "node:test";
import assert from "node:assert/strict";
import { buildDisplayLabels } from "../src/dataset/disambiguate.js";

const label = (players, id) => buildDisplayLabels(players).get(id);

test("a unique name is shown plainly", () => {
  const players = [{ id: "A", name: "Zlatan Ibrahimović", birthYear: 1981 }];
  assert.equal(label(players, "A"), "Zlatan Ibrahimović");
});

test("distinct full names are never shortened, even sharing a word", () => {
  // Both are unique, so both display in full. Shortening here would be
  // less clear for no gain.
  const players = [
    { id: "A", name: "Cristiano Ronaldo", birthYear: 1985 },
    { id: "B", name: "Ronaldo Nazário", birthYear: 1976 },
  ];
  assert.equal(label(players, "A"), "Cristiano Ronaldo");
  assert.equal(label(players, "B"), "Ronaldo Nazário");
});

test("father and son with different first names stay distinguishable in full", () => {
  // Danny and Daley Blind: both Ajax, both unique names, no year needed.
  const players = [
    { id: "A", name: "Danny Blind", birthYear: 1961 },
    { id: "B", name: "Daley Blind", birthYear: 1990 },
  ];
  assert.equal(label(players, "A"), "Danny Blind");
  assert.equal(label(players, "B"), "Daley Blind");
});

test("an identical name falls through to birth year", () => {
  const players = [
    { id: "A", name: "Fred", birthYear: 1983 },
    { id: "B", name: "Fred", birthYear: 1993 },
  ];
  assert.equal(label(players, "A"), "Fred (1983)");
  assert.equal(label(players, "B"), "Fred (1993)");
});

test("a colliding name without a birth year stays plain rather than 'undefined'", () => {
  const players = [
    { id: "A", name: "Fred" },
    { id: "B", name: "Fred", birthYear: 1993 },
  ];
  assert.equal(label(players, "A"), "Fred");
  assert.equal(label(players, "B"), "Fred (1993)");
});

test("mononyms need no special handling", () => {
  const players = [{ id: "A", name: "Hulk", birthYear: 1986 }];
  assert.equal(label(players, "A"), "Hulk");
});

test("a label never contains a club name", () => {
  // Game-correctness rule: showing clubs gives away exactly what is tested.
  const players = [
    { id: "A", name: "Cristiano Ronaldo", birthYear: 1985, clubIds: ["Q8682"] },
    { id: "B", name: "Ronaldo Nazário", birthYear: 1976, clubIds: ["Q7156"] },
  ];
  for (const value of buildDisplayLabels(players).values()) {
    assert.doesNotMatch(value, /Q\d+|Madrid|Barcelona|Inter|United/i);
  }
});

test("labels are stable regardless of input order", () => {
  const a = [
    { id: "A", name: "Fred", birthYear: 1983 },
    { id: "B", name: "Fred", birthYear: 1993 },
  ];
  const b = [a[1], a[0]];
  assert.deepEqual([...buildDisplayLabels(a)].sort(), [...buildDisplayLabels(b)].sort());
});
