import test from "node:test";
import assert from "node:assert/strict";
import { buildDisplayLabels } from "../src/dataset/disambiguate.js";

const label = (players, id) => buildDisplayLabels(players).get(id);

test("a unique name is shown plainly", () => {
  const players = [{ id: "A", name: "Zlatan Ibrahimović", birthYear: 1981 }];
  assert.equal(label(players, "A"), "Zlatan Ibrahimović");
});

test("a shared surname disambiguates by first initial", () => {
  const players = [
    { id: "A", name: "Cristiano Ronaldo", birthYear: 1985 },
    { id: "B", name: "Ronaldo Nazário", birthYear: 1976 },
  ];
  assert.equal(label(players, "A"), "C. Ronaldo");
  assert.equal(label(players, "B"), "R. Nazário");
});

test("same initial and surname falls through to birth year", () => {
  // Danny and Daley Blind: father and son, both Ajax, both "D. Blind".
  const players = [
    { id: "A", name: "Danny Blind", birthYear: 1961 },
    { id: "B", name: "Daley Blind", birthYear: 1990 },
  ];
  assert.equal(label(players, "A"), "D. Blind (1961)");
  assert.equal(label(players, "B"), "D. Blind (1990)");
});

test("mononyms display as-is", () => {
  const players = [{ id: "A", name: "Hulk", birthYear: 1986 }];
  assert.equal(label(players, "A"), "Hulk");
});

test("colliding mononyms fall through to birth year", () => {
  const players = [
    { id: "A", name: "Fred", birthYear: 1983 },
    { id: "B", name: "Fred", birthYear: 1993 },
  ];
  assert.equal(label(players, "A"), "Fred (1983)");
  assert.equal(label(players, "B"), "Fred (1993)");
});

test("a label never contains a club name", () => {
  // Game-correctness rule: showing clubs gives away exactly what is being
  // tested. This asserts the shape carries no club data at all.
  const players = [
    { id: "A", name: "Cristiano Ronaldo", birthYear: 1985, clubIds: ["Q8682"] },
    { id: "B", name: "Ronaldo Nazário", birthYear: 1976, clubIds: ["Q7156"] },
  ];
  for (const value of buildDisplayLabels(players).values()) {
    assert.doesNotMatch(value, /Q\d+|Madrid|Barcelona|Inter|United/i);
  }
});

test("names with multiple given names use only the first initial", () => {
  const players = [
    { id: "A", name: "Luís Carlos Almeida da Cunha", birthYear: 1981 },
    { id: "B", name: "Pedro Miguel da Cunha", birthYear: 1990 },
  ];
  assert.equal(label(players, "A"), "L. da Cunha");
  assert.equal(label(players, "B"), "P. da Cunha");
});

test("labels are stable regardless of input order", () => {
  const a = [
    { id: "A", name: "Danny Blind", birthYear: 1961 },
    { id: "B", name: "Daley Blind", birthYear: 1990 },
  ];
  const b = [a[1], a[0]];
  assert.deepEqual([...buildDisplayLabels(a)].sort(), [...buildDisplayLabels(b)].sort());
});
