/**
 * Display labels for the answer autocomplete.
 *
 * THE RULE: a label must never reveal which clubs a player played for. That is
 * precisely the knowledge the game tests, so a hint like
 * "Ronaldo (Barcelona, Inter)" would hand over the answer.
 *
 * So disambiguation escalates through the least revealing thing that works:
 *   1. plain name            "Zlatan Ibrahimović"
 *   2. first initial+surname "C. Ronaldo" / "R. Nazário"
 *   3. birth year            "D. Blind (1961)" / "D. Blind (1990)"
 *
 * Birth year leaks era, a far weaker signal than clubs, and only appears on a
 * genuine collision.
 */

// Particles that belong to the surname, not the given names.
const PARTICLES = new Set(["da", "de", "del", "della", "di", "dos", "du", "la", "le", "van", "von", "der", "den", "ten", "ter"]);

/** Split a full name into { initial, surname }. Mononyms yield initial: null. */
function splitName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return { initial: null, surname: parts[0] };

  // Walk back over particles so "Luís Carlos Almeida da Cunha" -> "da Cunha".
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;

  return { initial: parts[0][0].toUpperCase(), surname: parts.slice(i).join(" ") };
}

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

  // Tier 2 candidate label for every player, so collisions can be counted.
  const shortOf = new Map();
  const surnameCounts = new Map();

  for (const p of players) {
    const { initial, surname } = splitName(p.name);
    shortOf.set(p.id, initial ? `${initial}. ${surname}` : surname);
    surnameCounts.set(surname, (surnameCounts.get(surname) ?? 0) + 1);
  }

  const shortCounts = new Map();
  for (const short of shortOf.values()) {
    shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1);
  }

  // Build maps for cross-checking
  const firstNames = new Map();
  const surnames = new Map();
  for (const p of players) {
    const parts = String(p.name).trim().split(/\s+/);
    const firstName = parts[0];
    const { surname } = splitName(p.name);
    firstNames.set(firstName, (firstNames.get(firstName) ?? 0) + 1);
    surnames.set(surname, (surnames.get(surname) ?? 0) + 1);
  }

  const labels = new Map();
  for (const p of players) {
    const { surname } = splitName(p.name);
    const parts = String(p.name).trim().split(/\s+/);
    const firstName = parts[0];

    // Tier 1: use full name only if there's no ambiguity from any source
    const hasFullNameCollision = byName.get(p.name).length > 1;
    const hasSurnameCollision = surnameCounts.get(surname) > 1;
    // Check if my surname is someone's first name OR my first name is someone's surname
    const hasCrossmatch = (firstNames.has(surname) && firstNames.get(surname) > 0) ||
                         (surnames.has(firstName) && surnames.get(firstName) > 0);

    if (!hasFullNameCollision && !hasSurnameCollision && !hasCrossmatch) {
      labels.set(p.id, p.name); // tier 1: the full name is already unique
      continue;
    }

    const short = shortOf.get(p.id);
    if (shortCounts.get(short) === 1) {
      labels.set(p.id, short); // tier 2: initial + surname resolves it
      continue;
    }
    // tier 3: still ambiguous — the only remaining non-club signal.
    labels.set(p.id, p.birthYear ? `${short} (${p.birthYear})` : short);
  }
  return labels;
}
