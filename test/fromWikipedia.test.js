import test from "node:test";
import assert from "node:assert/strict";
import { careerClubTitles, normalizeTitle } from "../src/dataset/fromWikipedia.js";

// Trimmed from the real João Félix article — the case that motivated this
// whole pass. Wikidata had Chelsea and Milan and nothing else.
const FELIX = `
{{Infobox football biography
| name = João Félix
| youthclubs1 = Os Pestinhas
| youthclubs2 = [[FC Porto (youth)|Porto]]
| youthclubs4 = [[S.L. Benfica (youth)|Benfica]]
| years1 = 2016–2018
| clubs1 = [[S.L. Benfica B|Benfica B]]
| years2 = 2018–2019
| clubs2 = [[S.L. Benfica|Benfica]]
| years3 = 2019–2024
| clubs3 = [[Atlético Madrid]]
| years4 = 2023
| clubs4 = → [[Chelsea F.C.|Chelsea]] (loan)
| years5 = 2023–2024
| clubs5 = → [[FC Barcelona|Barcelona]] (loan)
| years7 = 2025
| clubs7 = → [[AC Milan]] (loan)
| nationalteam3 = [[Portugal national under-21 football team|Portugal U21]]
| nationalteam4 = [[Portugal national football team|Portugal]]
}}
`;

test("senior clubs are read in career order", () => {
  assert.deepEqual(careerClubTitles(FELIX), [
    "S.L. Benfica B", "S.L. Benfica", "Atlético Madrid",
    "Chelsea F.C.", "FC Barcelona", "AC Milan",
  ]);
});

test("a loan counts as a club they played for", () => {
  // "→ [[FC Barcelona|Barcelona]] (loan)". Dropping loans would leave the
  // exact gap this parser exists to close.
  assert.ok(careerClubTitles(FELIX).includes("FC Barcelona"));
});

test("youth and international appearances are not clubs", () => {
  const titles = careerClubTitles(FELIX);
  assert.ok(!titles.some((t) => t.includes("youth")), "youthclubs must not leak in");
  assert.ok(!titles.some((t) => t.includes("national")), "nationalteam must not leak in");
});

test("the link target is taken, not the display text", () => {
  // "Barcelona" is ambiguous; "FC Barcelona" is the article that carries a QID.
  const titles = careerClubTitles("| clubs1 = [[FC Barcelona|Barcelona]]");
  assert.deepEqual(titles, ["FC Barcelona"]);
});

test("an unlinked club is skipped rather than guessed at", () => {
  // No target means nothing to match a QID against. Inferring one from the
  // display text is how a join starts inventing data.
  assert.deepEqual(careerClubTitles("| clubs1 = Os Pestinhas\n| clubs2 = [[AC Milan]]"), ["AC Milan"]);
});

test("a section anchor is stripped from the target", () => {
  assert.deepEqual(careerClubTitles("| clubs1 = [[Real Madrid CF#History|Real Madrid]]"), ["Real Madrid CF"]);
});

test("underscores and stray whitespace normalise to the page title", () => {
  assert.deepEqual(careerClubTitles("| clubs1 = [[AC_Milan]]"), ["AC Milan"]);
  assert.equal(normalizeTitle("  fc__barcelona  "), "Fc barcelona");
});

test("a club appearing twice is listed once", () => {
  // Two spells at one club is still one club, same rule the scorer uses.
  const wt = "| clubs1 = [[AC Milan]]\n| clubs2 = [[Chelsea F.C.]]\n| clubs3 = [[AC Milan]]";
  assert.deepEqual(careerClubTitles(wt), ["AC Milan", "Chelsea F.C."]);
});

test("parameters that merely start with clubs are not senior career", () => {
  // "clubsnote" or "managerclubs1" would quietly poison the career list.
  const wt = "| clubsnote = [[Fake FC]]\n| managerclubs1 = [[Other FC]]\n| clubs1 = [[AC Milan]]";
  assert.deepEqual(careerClubTitles(wt), ["AC Milan"]);
});

test("an article with no infobox yields nothing rather than throwing", () => {
  assert.deepEqual(careerClubTitles("Just some prose about a footballer."), []);
  assert.deepEqual(careerClubTitles(""), []);
  assert.deepEqual(careerClubTitles(undefined), []);
  assert.deepEqual(careerClubTitles(null), []);
});
