import { formatLabel } from "./label.js";

/**
 * Loads the baked dataset into memory and exposes lookup + autocomplete.
 *
 * At ~25k players a linear scan per keystroke is fine (single-digit
 * milliseconds), so there is no index to keep in sync. Normalisation is
 * precomputed once because that is the part that would actually cost.
 */

/** Lowercase and strip accents, so "ibrahimovic" finds "Ibrahimović". */
export function normalize(s) {
  return String(s)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export function createDataset({ clubs, players }) {
  const byId = new Map(players.map((p) => [p.id, p]));

  // Precomputed search keys: the whole name plus each word, so "Ibra" and
  // "Zlatan" both hit.
  const searchable = players.map((p) => {
    const norm = normalize(p.name);
    // clubCount is a fame proxy, and a well-aimed one: it counts only the 97
    // clubs this game is played with, so a player who turned out for eight of
    // them is exactly the player someone typing a common surname meant.
    return {
      id: p.id, label: formatLabel(p), norm,
      words: norm.split(/\s+/), clubCount: p.clubIds.length,
    };
  });

  function search(query, limit = 8) {
    const q = normalize(query);
    if (q.length < 2) return [];

    // Partitioned, not truncated-then-sorted: a better match must outrank a
    // worse one regardless of where it sits in the array. Scanning all entries
    // is cheap (~50k prefix checks) and removes the ordering bug an early
    // break once introduced.
    //
    // An exact word beats a prefix, which is the whole point: typing "messi"
    // used to return Messias Timula, Danilo Messina, Giuseppe Messina and
    // Junior Messias before Lionel Messi, because those sort earlier
    // alphabetically and every one of them was merely a prefix match.
    const tiers = [[], [], [], []];
    for (const entry of searchable) {
      if (entry.norm === q) tiers[0].push(entry);
      else if (entry.words.includes(q)) tiers[1].push(entry);
      else if (entry.norm.startsWith(q)) tiers[2].push(entry);
      else if (entry.words.some((w) => w.startsWith(q))) tiers[3].push(entry);
    }

    // Within a tier, prefer the player who appears in more of this game's
    // clubs, then fall back to name order so the result is deterministic.
    const rank = (a, b) => b.clubCount - a.clubCount || a.norm.localeCompare(b.norm);
    for (const t of tiers) t.sort(rank);

    return tiers.flat().slice(0, limit).map(({ id, label }) => ({ id, label }));
  }

  return {
    clubs,
    players,
    getPlayer: (id) => byId.get(id) ?? null,
    // The same label shown in the autocomplete, so the reveal names a player
    // exactly as they were chosen — no second naming scheme to reconcile.
    getPlayerLabel: (id) => { const p = byId.get(id); return p ? formatLabel(p) : null; },
    getPlayerClubs: (id) => byId.get(id)?.clubIds ?? [],
    search,
  };
}
