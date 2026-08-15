/**
 * Parses senior-career club links out of a Wikipedia article's wikitext.
 *
 * Wikidata's P54 statements are what data/dataset.json is built from, and they
 * are incomplete: João Félix's had no Benfica, no Atlético and no Barcelona,
 * while his Wikipedia infobox listed all three. The infobox is hand-maintained
 * by people who follow the sport, so it is materially better for exactly the
 * thing this game asks about.
 *
 * Pure, like every other adapter here — the fetching lives in
 * scripts/enrich-careers.mjs.
 */

/**
 * Senior career only.
 *
 * The infobox keeps youth and international appearances under their own
 * parameters — youthclubs1, nationalteam1 — so matching `clubs<digits>`
 * exactly excludes both without having to recognise a youth team or a country
 * by name. `managerclubs` is excluded for the same reason: managing a club is
 * not playing for it.
 */
const CLUB_PARAM = /^\s*\|\s*clubs(\d+)\s*=\s*(.*?)\s*$/gm;

/** [[Target]] or [[Target|Label]] — the target is what identifies the article. */
const FIRST_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/;

/**
 * Normalise a link target to the form Wikipedia reports as a page title:
 * spaces not underscores, collapsed whitespace, leading capital.
 */
export function normalizeTitle(raw) {
  const t = String(raw).replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/**
 * @param {string} wikitext raw article source
 * @returns {string[]} article titles of senior clubs, in career order, deduped
 *
 * Entries with no wikilink (an unlinked club name like "Os Pestinhas") are
 * skipped: without a target there is nothing to match against a QID, and
 * guessing from the display text is how a join starts inventing data.
 */
export function careerClubTitles(wikitext) {
  if (typeof wikitext !== "string") return [];

  const found = [];
  const seen = new Set();
  // A loan reads "→ [[FC Barcelona|Barcelona]] (loan)". It is still a club
  // they played for, which is the whole point of the fix, so it is kept.
  for (const [, , value] of wikitext.matchAll(CLUB_PARAM)) {
    const link = value.match(FIRST_LINK);
    if (!link) continue;
    const title = normalizeTitle(link[1]);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    found.push(title);
  }
  return found;
}
