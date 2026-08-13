/**
 * The sole adapter between Wikidata's response shape and the game's dataset.
 * Pure — the network call lives in scripts/build-dataset.mjs.
 *
 * Swapping to a Transfermarkt-derived source later means rewriting this file
 * and nothing else.
 */

const qid = (url) => String(url).split("/").pop();

/**
 * @param {Array<{id:string,name:string,country:string}>} clubs curated list
 * @param {Array<object>} rows raw SPARQL bindings
 * @returns {{clubs:Array, players:Array<{id,name,birthYear,clubIds}>}}
 */
export function shapeDataset(clubs, rows) {
  const curated = new Set(clubs.map((c) => c.id));
  const byPlayer = new Map();

  for (const r of rows) {
    const id = qid(r.player.value);
    const name = r.playerLabel?.value;

    // Wikidata echoes the QID as the label when there is no English label.
    // Such a player is unnameable in the UI, so drop the row.
    if (!name || name === id) continue;

    const clubId = qid(r.club.value);
    // Restricting to the curated list is load-bearing: it keeps national teams
    // out and avoids ever having to classify an arbitrary team.
    if (!curated.has(clubId)) continue;

    if (!byPlayer.has(id)) {
      const year = r.dob?.value ? Number(String(r.dob.value).slice(0, 4)) : undefined;
      byPlayer.set(id, {
        id,
        name,
        birthYear: Number.isFinite(year) ? year : undefined,
        countries: new Set(),
        clubIds: new Set(),
      });
    }
    const entry = byPlayer.get(id);
    entry.clubIds.add(clubId);
    // Wikidata emits one row per citizenship; collect then pick one, so a
    // dual national's label cannot flap between builds.
    if (r.iso?.value) entry.countries.add(String(r.iso.value).toUpperCase());
  }

  const players = [...byPlayer.values()]
    .map(({ countries, ...p }) => ({
      ...p,
      country: [...countries].sort()[0],
      clubIds: [...p.clubIds].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id)); // deterministic output

  return { clubs, players };
}
