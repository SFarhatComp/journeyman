/**
 * Builds data/nhl-clubs.json and data/nhl-dataset.json from the NHL's own API.
 *
 * Wikidata is what the football dataset is built from, and it works for hockey
 * too — Montreal has 861 players under the same P54 property. But the NHL
 * publishes this itself: free, no key, structured, and complete back to
 * 1917-18. When the official source is both better and permitted, scraping a
 * third party or inferring from a knowledge graph is work for no reason.
 *
 * Shape matches the football dataset exactly, because the game engine does not
 * know what sport it is running:
 *   clubs:   [{ id, name, country, league }]
 *   players: [{ id, name, birthYear, country, clubIds }]
 *
 * Run: ./journeyman.sh nhl
 *
 * Rosters are cached per team-season. A run that dies partway resumes instead
 * of restarting — the football rebuild cost four attempts learning that.
 */
import { readFile, writeFile, rm } from "node:fs/promises";

const UA = "journeyman/0.1 (personal sports trivia game)";
const WEB = "https://api-web.nhle.com/v1";
const GAP_MS = 250;
const CACHE = new URL("../data/.nhl-rosters.json", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;              // no roster that season
      if (res.status === 429 || res.status >= 500) {
        const wait = 2000 * 2 ** attempt;
        console.log(`  ${res.status} on ${url.slice(-30)}, waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      return null;
    } catch (err) {
      console.log(`  network error (${err.message.slice(0, 40)}), retrying`);
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw new Error(`gave up on ${url}`);
}

/**
 * The API reports birth country as three letters (CAN); the football dataset
 * uses two (NL). Neither is wrong, but a game that shows both looks broken, so
 * the common hockey nations are mapped and anything else keeps its own code.
 */
const ISO3_TO_ISO2 = {
  CAN: "CA", USA: "US", SWE: "SE", FIN: "FI", RUS: "RU", CZE: "CZ", SVK: "SK",
  SUI: "CH", GER: "DE", DEN: "DK", NOR: "NO", LAT: "LV", AUT: "AT", FRA: "FR",
  SLO: "SI", BLR: "BY", UKR: "UA", KAZ: "KZ", POL: "PL", GBR: "GB", AUS: "AU",
  JPN: "JP", CRO: "HR", ITA: "IT", NED: "NL", EST: "EE", LTU: "LT", BRA: "BR",
  KOR: "KR", CHN: "CN", HUN: "HU", ROU: "RO", SRB: "RS", VEN: "VE", NGA: "NG",
  HAI: "HT", JAM: "JM", MEX: "MX", ZAF: "ZA", ISR: "IL", TWN: "TW", THA: "TH",
};
const iso2 = (c) => ISO3_TO_ISO2[c] ?? (c ? String(c).slice(0, 2) : undefined);

// --- teams ------------------------------------------------------------------

console.log("Fetching the current 32 teams…");
const standings = await get(`${WEB}/standings/now`);
const teams = standings.standings.map((t) => ({
  id: t.teamAbbrev.default,                 // MTL, TOR — readable and unique
  name: t.teamName.default,
  country: t.teamAbbrev.default,            // placeholder; overwritten below
  conference: t.conferenceName,
  division: t.divisionName,
  logo: t.teamLogo,
}));
console.log(`  ${teams.length} teams`);

// The football pool groups by league for the sticky headers in the draft grid.
// Division is the closest hockey equivalent and gives four tidy groups.
const clubs = teams
  .map((t) => ({ id: t.id, name: t.name, country: t.division, league: `${t.conference} — ${t.division}` }))
  .sort((a, b) => a.league.localeCompare(b.league) || a.name.localeCompare(b.name));

await writeFile(new URL("../data/nhl-clubs.json", import.meta.url), JSON.stringify(clubs, null, 2));
await writeFile(new URL("../data/nhl-logos.json", import.meta.url),
  JSON.stringify(Object.fromEntries(teams.map((t) => [t.id, t.logo])), null, 2));

// --- rosters ----------------------------------------------------------------

let cache = {};
try { cache = JSON.parse(await readFile(CACHE, "utf8")); } catch { /* first run */ }

const players = new Map(); // playerId -> { id, name, birthYear, country, clubIds:Set }

for (const [i, team] of teams.entries()) {
  const seasons = await get(`${WEB}/roster-season/${team.id}`) ?? [];
  console.log(`[${i + 1}/${teams.length}] ${team.name}: ${seasons.length} seasons`);

  for (const season of seasons) {
    const key = `${team.id}-${season}`;
    let roster = cache[key];
    if (!roster) {
      const data = await get(`${WEB}/roster/${team.id}/${season}`);
      roster = [...(data?.forwards ?? []), ...(data?.defensemen ?? []), ...(data?.goalies ?? [])]
        .map((p) => ({
          id: String(p.id),
          name: `${p.firstName?.default ?? ""} ${p.lastName?.default ?? ""}`.trim(),
          birthDate: p.birthDate,
          country: p.birthCountry,
        }))
        .filter((p) => p.name);
      cache[key] = roster;
      await sleep(GAP_MS);
    }

    for (const p of roster) {
      const existing = players.get(p.id);
      if (existing) { existing.clubIds.add(team.id); continue; }
      const year = p.birthDate ? Number(String(p.birthDate).slice(0, 4)) : undefined;
      players.set(p.id, {
        id: p.id,
        name: p.name,
        birthYear: Number.isFinite(year) ? year : undefined,
        country: iso2(p.country),
        clubIds: new Set([team.id]),
      });
    }
  }
  await writeFile(CACHE, JSON.stringify(cache));
}

const dataset = {
  clubs,
  players: [...players.values()].map((p) => ({ ...p, clubIds: [...p.clubIds] })),
};
if (dataset.players.length === 0) throw new Error("no players — refusing to write");

await rm(CACHE, { force: true });
await writeFile(new URL("../data/nhl-dataset.json", import.meta.url), JSON.stringify(dataset));

console.log(`\nWrote ${dataset.players.length} players across ${dataset.clubs.length} teams.`);
console.log("Logos: ./journeyman.sh nhl-crests");
