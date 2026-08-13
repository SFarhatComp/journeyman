import test from "node:test";
import assert from "node:assert/strict";
import { formatLabel } from "../src/dataset/label.js";

test("a normal name becomes initial, surname, year and country", () => {
  assert.equal(
    formatLabel({ name: "Cristiano Ronaldo", birthYear: 1985, country: "PT" }),
    "C. Ronaldo (1985, PT)",
  );
});

test("players sharing an initial and surname are separated by year", () => {
  // Danny and Daley Blind: father and son, both Ajax, both Dutch.
  const danny = { name: "Danny Blind", birthYear: 1961, country: "NL" };
  const daley = { name: "Daley Blind", birthYear: 1990, country: "NL" };
  assert.equal(formatLabel(danny), "D. Blind (1961, NL)");
  assert.equal(formatLabel(daley), "D. Blind (1990, NL)");
  assert.notEqual(formatLabel(danny), formatLabel(daley));
});

test("a mononym keeps its single name with no initial", () => {
  assert.equal(formatLabel({ name: "Hulk", birthYear: 1986, country: "BR" }), "Hulk (1986, BR)");
});

test("surname particles stay with the surname", () => {
  assert.equal(
    formatLabel({ name: "Luís Carlos Almeida da Cunha", birthYear: 1981, country: "PT" }),
    "L. da Cunha (1981, PT)",
  );
});

test("a missing birth year is omitted rather than printed as undefined", () => {
  assert.equal(formatLabel({ name: "Old Player", country: "EN" }), "O. Player (EN)");
});

test("a missing country is omitted rather than printed as undefined", () => {
  assert.equal(formatLabel({ name: "Old Player", birthYear: 1920 }), "O. Player (1920)");
});

test("with neither year nor country the parenthetical disappears entirely", () => {
  assert.equal(formatLabel({ name: "Old Player" }), "O. Player");
});

test("a label never contains a club name", () => {
  // Game-correctness rule: showing clubs gives away exactly what is tested.
  const label = formatLabel({ name: "Cristiano Ronaldo", birthYear: 1985, country: "PT" });
  assert.doesNotMatch(label, /Q\d+|Madrid|Barcelona|Inter|United|Juventus/i);
});

test("the same input always produces the same label", () => {
  const p = { name: "Zlatan Ibrahimović", birthYear: 1981, country: "SE" };
  assert.equal(formatLabel(p), formatLabel(p));
  assert.equal(formatLabel(p), "Z. Ibrahimović (1981, SE)");
});
