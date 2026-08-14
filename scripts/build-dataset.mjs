/**
 * Builds data/dataset.json from Wikidata. Run manually: ./footfinder.sh dataset
 *
 * Deliberately NOT part of the test run or the image build — pointing
 * scheduled traffic at a public endpoint would be rude, and an upstream
 * outage must not break the build.
 */
import { readFile, writeFile } from "node:fs/promises";
import { shapeDataset } from "../src/dataset/fromWikidata.js";

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "footfinder/0.1 (personal football trivia game)";

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

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
    });
    if (res.ok) return (await res.json()).results.bindings;
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
  throw new Error(`${clubId}: failed after 3 attempts`);
}

const clubs = JSON.parse(await readFile(new URL("../data/clubs.json", import.meta.url), "utf8"));
console.log(`Fetching rosters for ${clubs.length} clubs…`);

const rows = [];
for (const [i, club] of clubs.entries()) {
  const roster = await fetchClubRoster(club.id);
  rows.push(...roster);
  console.log(`  [${i + 1}/${clubs.length}] ${club.name}: ${roster.length} players`);
  await sleep(1000); // be a good citizen
}

const dataset = shapeDataset(clubs, rows);
if (dataset.players.length === 0) throw new Error("dataset is empty — refusing to write");

await writeFile(
  new URL("../data/dataset.json", import.meta.url),
  JSON.stringify(dataset),
);
console.log(`\nWrote ${dataset.players.length} players across ${dataset.clubs.length} clubs.`);
