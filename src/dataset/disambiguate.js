/**
 * Display labels for the answer autocomplete.
 *
 * THE RULE: a label must never reveal which clubs a player played for. That is
 * precisely the knowledge the game tests, so a hint like
 * "Ronaldo (Barcelona, Inter)" would hand over the answer.
 *
 * Two tiers:
 *   1. plain name        "Zlatan Ibrahimović", "Danny Blind", "Daley Blind"
 *   2. + birth year      "Fred (1983)" / "Fred (1993)", only when two players
 *                        share an identical name
 *
 * An earlier draft had a middle tier shortening to initial + surname. It was
 * unreachable: a tier-1 collision means two identical name strings, and
 * shortening identical strings yields identical results. Full names are also
 * clearer in a dropdown and equally club-free.
 */

/**
 * @param {Array<{id:string, name:string, birthYear?:number}>} players
 * @returns {Map<string,string>} entity id -> display label
 */
export function buildDisplayLabels(players) {
  const byName = new Map();
  for (const p of players) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }

  const labels = new Map();
  for (const p of players) {
    const unique = byName.get(p.name).length === 1;
    // Without a birth year there is nothing non-revealing left to add, so an
    // ambiguous label beats inventing a distinction or printing "undefined".
    labels.set(p.id, unique || !p.birthYear ? p.name : `${p.name} (${p.birthYear})`);
  }
  return labels;
}
