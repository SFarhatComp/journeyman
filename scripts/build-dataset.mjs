/**
 * Builds data/dataset.json from Wikidata. Run manually: ./journeyman.sh dataset
 *
 * Deliberately NOT part of the test run or the image build — pointing
 * scheduled traffic at a public endpoint would be rude, and an upstream
 * outage must not break the build.
 */
import { readFile, writeFile, rm } from "node:fs/promises";
import { shapeDataset } from "../src/dataset/fromWikidata.js";

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "journeyman/0.1 (personal football trivia game)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchClubRoster(clubId) {
  // P54 = member of sports team. Fetch per club so each query stays small
  // enough to beat the endpoint's 60s timeout.
  const query = `
    SELECT ?player ?playerLabel ?dob ?iso ?club WHERE {
      ?player p:P54/ps:P54 wd:${clubId} .
      ?player wdt:P31 wd:Q5 .
      BIND(wd:${clubId} AS ?club)
      OPTIONAL { ?player wdt:P569 ?dob }
      # P27 = country of citizenship, P297 = its ISO 3166-1 alpha-2 code.
      # A dual national yields one row per citizenship; the adapter picks one.
      OPTIONAL { ?player wdt:P27/wdt:P297 ?iso }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
    });
    if (res.ok) {
      try {
        return (await res.json()).results.bindings;
      } catch (err) {
        // The service closes a response mid-JSON when it is under load. The
        // same query succeeds on its own minutes later — verified by running
        // it directly — so this is a "come back later" signal, and backing
        // off for seconds is not backing off at all.
        console.log(`  ${clubId}: truncated response, waiting ${10 * 2 ** attempt}s`);
        await sleep(10_000 * 2 ** attempt);
        continue;
      }
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2000 * (attempt + 1);
      console.log(`  ${clubId}: HTTP ${res.status}, retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${clubId}: HTTP ${res.status}`);
  }
  throw new Error(`${clubId}: failed after 5 attempts`);
}

/**
 * Article titles for entities Wikidata could not name in English.
 *
 * A separate pass on purpose. Joining the sitelink into the roster query made
 * it heavy enough that the query service started truncating responses
 * partway through the run. This asks only about the handful of players that
 * actually need it, 50 at a time, from an endpoint built for key lookups.
 */
async function articleTitles(qids) {
  const out = new Map();
  for (let i = 0; i < qids.length; i += 50) {
    const slice = qids.slice(i, i + 50);
    const url = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json"
      + `&formatversion=2&props=sitelinks&sitefilter=enwiki&maxlag=5&ids=${slice.join("|")}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const data = await res.json();
      for (const [qid, entity] of Object.entries(data.entities ?? {})) {
        const title = entity.sitelinks?.enwiki?.title;
        if (title) out.set(qid, title);
      }
    }
    await sleep(400);
  }
  return out;
}

const clubs = JSON.parse(await readFile(new URL("../data/clubs.json", import.meta.url), "utf8"));
console.log(`Fetching rosters for ${clubs.length} clubs…`);

// Rosters are cached per club as they arrive. A run that dies on club 25 of
// 97 used to throw away everything before it, and the endpoint is flaky
// enough that finishing in one attempt is not something to rely on.
const CACHE = new URL("../data/.rosters.json", import.meta.url);
let cache = {};
try { cache = JSON.parse(await readFile(CACHE, "utf8")); } catch { /* first run */ }

const rows = [];
for (const [i, club] of clubs.entries()) {
  let roster = cache[club.id];
  if (roster) {
    console.log(`  [${i + 1}/${clubs.length}] ${club.name}: ${roster.length} players (cached)`);
  } else {
    try {
      roster = await fetchClubRoster(club.id);
    } catch (err) {
      // Everything fetched so far is already on disk. Say so plainly: the
      // answer is to run it again, not to debug anything.
      console.error(`\n${err.message}`);
      console.error(`\n${Object.keys(cache).length}/${clubs.length} clubs are cached.`);
      console.error("The query service throttles under sustained load. Run"
        + " ./journeyman.sh dataset again — it resumes from the cache.");
      process.exit(1);
    }
    cache[club.id] = roster;
    await writeFile(CACHE, JSON.stringify(cache));
    console.log(`  [${i + 1}/${clubs.length}] ${club.name}: ${roster.length} players`);
    await sleep(2000); // be a good citizen — our own load is what degrades it
  }
  rows.push(...roster);
}

// Wikidata echoes the QID back when it has no English label. Those are the
// only players that need an article title, and there are few enough that
// asking about them separately costs almost nothing.
const unnamed = [...new Set(rows
  .filter((r) => r.playerLabel?.value === r.player.value.split("/").pop())
  .map((r) => r.player.value.split("/").pop()))];
console.log(`\n${unnamed.length} players have no English label — resolving article titles…`);
const titles = await articleTitles(unnamed);
console.log(`  recovered ${titles.size} of ${unnamed.length}`);

const dataset = shapeDataset(clubs, rows, titles);
if (dataset.players.length === 0) throw new Error("dataset is empty — refusing to write");

await rm(CACHE, { force: true }); // a finished run must not seed the next one
await writeFile(
  new URL("../data/dataset.json", import.meta.url),
  JSON.stringify(dataset),
);
console.log(`\nWrote ${dataset.players.length} players across ${dataset.clubs.length} clubs.`);
console.log("\nThis is Wikidata only — it has REPLACED any Wikipedia enrichment.");
console.log("Run ./journeyman.sh enrich to put the career gaps back.");
