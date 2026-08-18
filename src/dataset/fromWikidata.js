/**
 * The sole adapter between Wikidata's response shape and the game's dataset.
 * Pure — the network call lives in scripts/build-dataset.mjs.
 *
 * Swapping to a Transfermarkt-derived source later means rewriting this file
 * and nothing else.
 */

const qid = (url) => String(url).split("/").pop();

/**
 * What to call a player.
 *
 * Wikidata echoes the QID back as the label when there is no English one, and
 * those rows used to be dropped as unnameable. That silently lost Luka
 * Modrić: his entity carries 59 labels, none of them English, while the
 * English Wikipedia article about him is titled "Luka Modrić". Falling back
 * to the article title recovers players like him.
 *
 * The trailing disambiguator Wikipedia uses — "(footballer)", "(footballer,
 * born 1990)" — is dropped, since it is a property of article naming rather
 * than of the person.
 */
function playerName(row, id, titles) {
  const label = row.playerLabel?.value;
  if (label && label !== id) return label;

  const title = titles?.get?.(id) ?? titles?.[id];
  if (!title) return null;
  // Drop Wikipedia's disambiguator — "(footballer)", "(footballer, born
  // 1990)" — which is a property of article naming, not of the person.
  return String(title).replace(/_/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
}

/**
 * @param {Array<{id:string,name:string,country:string}>} clubs curated list
 * @param {Array<object>} rows raw SPARQL bindings
 * @param {Map<string,string>} titles QID -> article title, for players Wikidata
 *   has no English label for
 * @returns {{clubs:Array, players:Array<{id,name,birthYear,country,clubIds}>}}
 */
export function shapeDataset(clubs, rows, titles = new Map()) {
  const curated = new Set(clubs.map((c) => c.id));
  const byPlayer = new Map();

  for (const r of rows) {
    const id = qid(r.player.value);
    const name = playerName(r, id, titles);

    // Still nothing to call them by: no English label and no article either.
    // A player nobody can type is a player nobody can score.
    if (!name) continue;

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
