/**
 * Enrich data/dataset.json with senior-career clubs from Wikipedia infoboxes.
 *
 * Wikidata's P54 statements are what the dataset is built from and they are
 * incomplete: João Félix's had Chelsea and Milan but not Benfica, Atlético or
 * Barcelona, while his Wikipedia infobox listed every one. The infobox is
 * maintained by people who follow the sport, so this pass closes gaps that the
 * structured data does not know it has.
 *
 * Run: ./footfinder.sh enrich   (add --limit N to trial it, --dry to not write)
 *
 * Additive only. It never removes a club Wikidata asserted — a disagreement
 * between the two sources is not evidence that Wikidata is the wrong one, and
 * a pass that can delete is a pass that can quietly gut the dataset.
 *
 * Politeness: batched 50 articles per request, one request at a time, with
 * maxlag so the API can tell us to back off. Progress is cached, so an
 * interrupted run resumes instead of starting the whole thing again.
 */
import { readFile, writeFile } from "node:fs/promises";
import { careerClubTitles, normalizeTitle } from "../src/dataset/fromWikipedia.js";

const UA = "footfinder/0.1 (personal football trivia game)";
const API = "https://en.wikipedia.org/w/api.php";
const SPARQL = "https://query.wikidata.org/sparql";
const BATCH = 50;        // the API's title limit for anonymous requests
const GAP_MS = 650;
const CACHE = new URL("../data/.enrich-cache.json", import.meta.url);

const args = process.argv.slice(2);
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0);
const DRY = args.includes("--dry");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeFetch(url, accept) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, ...(accept && { Accept: accept }) } });
    } catch (err) {
      // A dropped connection mid-run should cost a retry, not the whole job.
      console.error(`       network error (${err.message}), retrying`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt;
      console.error(`       HTTP ${res.status}, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    return null;
  }
  return null;
}

/**
 * QID -> English Wikipedia title.
 *
 * wbgetentities, not SPARQL. A VALUES clause of 800 QIDs made the query
 * service return 503 after five backoffs — it is built for graph questions,
 * not for fifty thousand key lookups. This endpoint takes 50 ids a call and
 * simply answers. Results are cached, because 1,000 calls is worth not
 * repeating.
 */
async function sitelinks(qids, cache) {
  const out = new Map();
  const todo = [];
  for (const q of qids) {
    if (q in cache) { if (cache[q]) out.set(q, cache[q]); }
    else todo.push(q);
  }

  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const url = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json"
      + "&formatversion=2&props=sitelinks&sitefilter=enwiki&maxlag=5"
      + `&ids=${slice.join("|")}`;
    const res = await politeFetch(url);
    if (res) {
      const data = await res.json();
      for (const [qid, entity] of Object.entries(data.entities ?? {})) {
        const title = entity.sitelinks?.enwiki?.title;
        // null, not absent: an entity with no English article must be
        // remembered as having none, or every resumed run asks again.
        cache[qid] = title ? normalizeTitle(title) : null;
        if (cache[qid]) out.set(qid, cache[qid]);
      }
    }
    for (const q of slice) if (!(q in cache)) cache[q] = null;

    const done = Math.min(i + BATCH, todo.length);
    process.stderr.write(`\r  sitelinks ${done}/${todo.length}`);
    await sleep(GAP_MS);
  }
  if (todo.length) process.stderr.write("\n");
  return out;
}

/**
 * QID -> article title for every player on our clubs' rosters.
 *
 * One query per club, joining P54 straight to the sitelink — the same shape
 * build-dataset.mjs already runs 97 times without trouble, and every player in
 * the dataset came from one of these rosters by construction, so the union is
 * complete.
 *
 * The obvious alternative, asking wbgetentities for 52,000 ids fifty at a
 * time, gets rate-limited to roughly 75 lookups a minute once it warms up:
 * an eleven-hour run for the same answer. 97 queries beats 1,040 requests.
 */
async function playerArticles(clubs, cache) {
  const done = new Set(cache.rosters ?? []);
  for (const [i, club] of clubs.entries()) {
    if (!done.has(club.id)) {
      const query = `SELECT ?player ?article WHERE {
        ?player p:P54/ps:P54 wd:${club.id} .
        ?player wdt:P31 wd:Q5 .
        ?article schema:about ?player ; schema:isPartOf <https://en.wikipedia.org/> .
      }`;
      const res = await politeFetch(`${SPARQL}?query=${encodeURIComponent(query)}`,
        "application/sparql-results+json");
      if (res) {
        for (const b of (await res.json()).results.bindings) {
          cache.sitelinks[b.player.value.split("/").pop()] =
            normalizeTitle(decodeURIComponent(b.article.value.split("/wiki/").pop()));
        }
        // Only mark the club done if the query actually came back, or a
        // resumed run would skip a roster it never read.
        done.add(club.id);
        cache.rosters = [...done];
      }
      await sleep(GAP_MS);
    }
    process.stderr.write(`\r  rosters ${i + 1}/${clubs.length}`);
    if ((i + 1) % 10 === 0) await flush();
  }
  process.stderr.write("\n");
  await flush();
}

/**
 * Every title that reaches one of our clubs, canonical plus redirects.
 *
 * Player infoboxes link clubs however the editor felt like: [[Atlético
 * Madrid]], [[Club Atlético de Madrid]], [[Atletico Madrid]]. Matching only
 * the canonical title would silently drop most of them, and a silent drop here
 * looks exactly like "Wikipedia had nothing to add".
 */
async function clubTitleIndex(clubs, cache) {
  const canonical = await sitelinks(clubs.map((c) => c.id), cache);
  const index = new Map();
  for (const [qid, title] of canonical) index.set(title, qid);

  const titles = [...canonical.values()];
  for (let i = 0; i < titles.length; i += BATCH) {
    const slice = titles.slice(i, i + BATCH);
    const url = `${API}?action=query&format=json&formatversion=2&maxlag=5`
      + `&prop=redirects&rdlimit=max&titles=${encodeURIComponent(slice.join("|"))}`;
    const res = await politeFetch(url);
    if (!res) continue;
    const data = await res.json();
    for (const page of data.query?.pages ?? []) {
      const qid = index.get(normalizeTitle(page.title));
      if (!qid) continue;
      for (const r of page.redirects ?? []) index.set(normalizeTitle(r.title), qid);
    }
    await sleep(GAP_MS);
  }
  return index;
}

/** Article title -> senior club titles, cached across runs. */
async function fetchCareers(titles, cache) {
  const todo = titles.filter((t) => !(t in cache));
  console.error(`  ${todo.length} articles to fetch (${titles.length - todo.length} cached)`);

  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const url = `${API}?action=query&format=json&formatversion=2&maxlag=5`
      + `&prop=revisions&rvprop=content&rvslots=main&redirects=1`
      + `&titles=${encodeURIComponent(slice.join("|"))}`;
    const res = await politeFetch(url);

    if (res) {
      const data = await res.json();
      // A redirect means the page we asked for is not the page we got back;
      // the career still belongs to the title we asked for.
      const backwards = new Map();
      for (const r of data.query?.redirects ?? []) backwards.set(normalizeTitle(r.to), normalizeTitle(r.from));
      for (const page of data.query?.pages ?? []) {
        const wikitext = page.revisions?.[0]?.slots?.main?.content;
        const got = normalizeTitle(page.title);
        const asked = backwards.get(got) ?? got;
        cache[asked] = wikitext ? careerClubTitles(wikitext) : [];
      }
    }
    // Anything the API did not return at all must still be marked done, or a
    // resumed run retries it forever.
    for (const t of slice) if (!(t in cache)) cache[t] = [];

    const done = Math.min(i + BATCH, todo.length);
    process.stderr.write(`\r  articles ${done}/${todo.length}`);
    if (done % (BATCH * 20) === 0) await flush();
    await sleep(GAP_MS);
  }
  process.stderr.write("\n");
  await flush();
  return cache;
}

// ---------------------------------------------------------------------------

const clubs = JSON.parse(await readFile(new URL("../data/clubs.json", import.meta.url), "utf8"));
const dataset = JSON.parse(await readFile(new URL("../data/dataset.json", import.meta.url), "utf8"));
const clubName = Object.fromEntries(dataset.clubs.map((c) => [c.id, c.name]));

// Two caches in one file: which article an entity has, and what that article's
// infobox says. Both are expensive and neither changes hour to hour, so an
// interrupted run picks up where it stopped.
let cache = { sitelinks: {}, careers: {}, rosters: [] };
try {
  const loaded = JSON.parse(await readFile(CACHE, "utf8"));
  if (loaded.sitelinks && loaded.careers) cache = loaded;
} catch { /* first run */ }
const flush = () => writeFile(CACHE, JSON.stringify(cache));

console.error(`Indexing ${clubs.length} club articles and their redirects…`);
const titleToQid = await clubTitleIndex(clubs, cache.sitelinks);
console.error(`  ${titleToQid.size} titles resolve to one of our ${clubs.length} clubs\n`);

const players = LIMIT ? dataset.players.slice(0, LIMIT) : dataset.players;
console.error(`Resolving player articles from ${clubs.length} club rosters…`);
await playerArticles(clubs, cache);
const playerTitle = new Map();
for (const p of players) {
  const title = cache.sitelinks[p.id];
  if (title) playerTitle.set(p.id, title);
}
console.error(`  ${playerTitle.size}/${players.length} have an English article\n`);

console.error("Fetching infoboxes…");
await fetchCareers([...new Set(playerTitle.values())], cache.careers);

// --- merge, additively -----------------------------------------------------
const gained = [];
let addedTotal = 0;
for (const player of players) {
  const title = playerTitle.get(player.id);
  if (!title) continue;
  const held = new Set(player.clubIds);
  const added = [];
  for (const clubTitle of cache.careers[title] ?? []) {
    const qid = titleToQid.get(clubTitle);
    if (!qid || held.has(qid)) continue;
    held.add(qid);
    added.push(qid);
  }
  if (added.length === 0) continue;
  player.clubIds = [...held];
  addedTotal += added.length;
  gained.push({ name: player.name, added: added.map((q) => clubName[q] ?? q) });
}

/**
 * Repair labels that are obviously not names.
 *
 * Wikidata's English label for Q1042372 is "don panini". He is Carlo Parola,
 * a Juventus and Lazio player whose bicycle kick became the Panini logo — the
 * Italian label is right and the English one has been vandalised. A player
 * nobody can type is a player nobody can score, so where the label starts
 * lowercase and an English article exists, the article title wins.
 *
 * Deliberately narrow. Article titles carry disambiguators and different
 * conventions, so preferring them wholesale would rename thousands of players
 * correctly labelled today. Eight names in 52,175 match this rule.
 */
const renamed = [];
for (const player of players) {
  if (!/^\p{Ll}/u.test(player.name)) continue;
  const title = playerTitle.get(player.id);
  if (!title) continue;
  const better = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!better || better === player.name) continue;
  renamed.push(`${player.name} -> ${better}`);
  player.name = better;
}
if (renamed.length) {
  console.error(`\n${renamed.length} labels repaired from their article title:`);
  for (const r of renamed) console.error(`  ${r}`);
}

console.error(`\n${gained.length} players gained ${addedTotal} club links.`);
for (const g of gained.slice(0, 25)) console.error(`  + ${g.name}: ${g.added.join(", ")}`);
if (gained.length > 25) console.error(`  … and ${gained.length - 25} more`);

const felix = players.find((p) => p.name === "João Félix");
if (felix) console.error(`\nJoão Félix now: ${felix.clubIds.map((q) => clubName[q] ?? q).join(", ")}`);

await writeFile(new URL("../data/enrich-report.json", import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), playersChanged: gained.length, linksAdded: addedTotal, renamed, gained }, null, 2));
console.error("\nFull diff: data/enrich-report.json");

if (DRY) {
  console.error("--dry: dataset.json not written.");
} else {
  await writeFile(new URL("../data/dataset.json", import.meta.url), JSON.stringify(dataset));
  console.error("data/dataset.json updated.");
}
