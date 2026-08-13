/**
 * The label shown in the answer autocomplete.
 *
 * THE RULE: a label must never reveal which clubs a player played for. That is
 * precisely the knowledge the game tests, so a hint like
 * "Ronaldo (Barcelona, Inter)" would hand over the answer.
 *
 * Every player gets the same shape — "C. Ronaldo (1985, PT)" — so there is no
 * collision detection, no tiering, and no need to see other players. An
 * earlier design escalated through tiers depending on whether a name was
 * unique; it produced a tier that could never execute. Uniformity removes that
 * class of bug by construction.
 *
 * Birth year and country are far weaker signals than clubs, and are only seen
 * after a name is typed — they cannot help find an answer, only confirm which
 * person was meant.
 */

// Particles belong to the surname, not the given names.
const PARTICLES = new Set(["da", "de", "del", "della", "di", "dos", "du", "la", "le", "van", "von", "der", "den", "ten", "ter"]);

/** "Luís Carlos Almeida da Cunha" -> "L. da Cunha"; "Hulk" -> "Hulk". */
function shortName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];

  // Walk back over particles so multi-word surnames stay intact.
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;

  return `${parts[0][0].toUpperCase()}. ${parts.slice(i).join(" ")}`;
}

/** @param {{name:string, birthYear?:number, country?:string}} player */
export function formatLabel(player) {
  const suffix = [player.birthYear, player.country].filter(Boolean).join(", ");
  return suffix ? `${shortName(player.name)} (${suffix})` : shortName(player.name);
}
