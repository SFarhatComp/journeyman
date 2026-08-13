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
    return { id: p.id, label: formatLabel(p), norm, words: norm.split(/\s+/) };
  });

  function search(query, limit = 8) {
    const q = normalize(query);
    if (q.length < 2) return [];

    const results = [];
    for (const entry of searchable) {
      // Prefix match on the full name or any word within it.
      if (entry.norm.startsWith(q) || entry.words.some((w) => w.startsWith(q))) {
        results.push(entry);
        if (results.length >= limit * 4) break; // bounded work per keystroke
      }
    }
    // Whole-name prefix matches first, then alphabetical for stability.
    results.sort((a, b) => {
      const aStarts = a.norm.startsWith(q) ? 0 : 1;
      const bStarts = b.norm.startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.norm.localeCompare(b.norm);
    });

    return results.slice(0, limit).map(({ id, label }) => ({ id, label }));
  }

  return {
    clubs,
    players,
    getPlayer: (id) => byId.get(id) ?? null,
    getPlayerClubs: (id) => byId.get(id)?.clubIds ?? [],
    search,
  };
}
