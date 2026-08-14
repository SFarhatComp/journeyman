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

    // Partitioned, not truncated-then-sorted: a whole-name match must outrank
    // every word match regardless of where it sits in the array. Scanning all
    // entries is cheap (~25k prefix checks) and removes the ordering bug that
    // an early break introduced.
    const whole = [];
    const word = [];
    for (const entry of searchable) {
      if (entry.norm.startsWith(q)) whole.push(entry);
      else if (entry.words.some((w) => w.startsWith(q))) word.push(entry);
    }

    const byName = (a, b) => a.norm.localeCompare(b.norm);
    whole.sort(byName);
    word.sort(byName);

    return [...whole, ...word].slice(0, limit).map(({ id, label }) => ({ id, label }));
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
