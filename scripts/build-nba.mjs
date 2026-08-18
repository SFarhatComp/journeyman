/**
 * Builds data/nba-clubs.json and data/nba-dataset.json from stats.nba.com.
 *
 * The NHL publishes a clean public API; the NBA does not, but the endpoints
 * behind nba.com are reachable with the headers a browser sends, and they are
 * complete: every player since 1946, and rosters for all 1,719 team-seasons
 * the 30 active franchises have played.
 *
 * They are also rate limited, hard, and answer a throttled request with an
 * HTML error page rather than a status code — so a JSON parse failure here
 * means "slow down", not "malformed".
 *
 * Shape matches football and hockey exactly, because the engine does not know
 * what sport it is running:
 *   clubs:   [{ id, name, country, league }]
 *   players: [{ id, name, birthYear, country, clubIds }]
 *
 * Run: ./footfinder.sh nba   — expect an hour, and expect to run it twice.
 * Rosters cache per team-season, so a second run resumes.
 */
import { readFile, writeFile, rm } from "node:fs/promises";

const STATS = "https://stats.nba.com/stats";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "Referer": "https://www.nba.com/", "Origin": "https://www.nba.com",
  "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
};
const GAP_MS = 1200;
const CACHE = new URL("../data/.nba-rosters.json", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      // A throttled request comes back as an HTML error page with status 200,
      // so the status alone cannot be trusted — the body shape is the signal.
      if (res.ok && text.startsWith("{")) return JSON.parse(text);
      const wait = 15_000 * 2 ** attempt;
      console.log(`  throttled (${res.status}), waiting ${wait / 1000}s`);
      await sleep(wait);
    } catch (err) {
      console.log(`  ${err.message.slice(0, 40)}, retrying`);
      await sleep(10_000 * 2 ** attempt);
    }
  }
  return null; // caller decides whether a gap is fatal
}

const cell = (rs, row, name) => row[rs.headers.indexOf(name)];

// --- teams ------------------------------------------------------------------

console.log("Fetching the 30 active franchises…");
const standings = await get(`${STATS}/leaguestandingsv3?LeagueID=00&Season=2024-25&SeasonType=Regular%20Season`);
if (!standings) throw new Error("could not read the standings — try again later");
const srs = standings.resultSets[0];
const info = new Map(srs.rowSet.map((r) => [String(cell(srs, r, "TeamID")), {
  name: `${cell(srs, r, "TeamCity")} ${cell(srs, r, "TeamName")}`,
  conference: cell(srs, r, "Conference"),
  division: cell(srs, r, "Division"),
}]));
await sleep(GAP_MS);

const years = await get(`${STATS}/commonteamyears?LeagueID=00`);
if (!years) throw new Error("could not read team years — try again later");
const yrs = years.resultSets[0];
const teams = yrs.rowSet
  .map((r) => ({
    id: String(cell(yrs, r, "TEAM_ID")),
    abbrev: cell(yrs, r, "ABBREVIATION"),
    min: Number(cell(yrs, r, "MIN_YEAR")),
    max: Number(cell(yrs, r, "MAX_YEAR")),
  }))
  .filter((t) => info.has(t.id))            // active franchises only
  .map((t) => ({ ...t, ...info.get(t.id) }));

console.log(`  ${teams.length} teams, ${teams.reduce((n, t) => n + t.max - t.min + 1, 0)} team-seasons`);

// The draft grid groups by league for its sticky headers; conference and
// division is the closest basketball equivalent, same as hockey.
const clubs = teams
  .map((t) => ({ id: t.abbrev, name: t.name, country: t.division, league: `${t.conference} — ${t.division}` }))
  .sort((a, b) => a.league.localeCompare(b.league) || a.name.localeCompare(b.name));

await writeFile(new URL("../data/nba-clubs.json", import.meta.url), JSON.stringify(clubs, null, 2));
await writeFile(new URL("../data/nba-logos.json", import.meta.url),
  JSON.stringify(Object.fromEntries(teams.map((t) =>
    [t.abbrev, `https://cdn.nba.com/logos/nba/${t.id}/global/L/logo.svg`])), null, 2));

// --- rosters ----------------------------------------------------------------

let cache = {};
try { cache = JSON.parse(await readFile(CACHE, "utf8")); } catch { /* first run */ }

const players = new Map();
let missed = 0;

for (const [i, team] of teams.entries()) {
  console.log(`[${i + 1}/${teams.length}] ${team.name}: ${team.min}-${team.max}`);
  for (let y = team.min; y < team.max; y++) {
    const season = `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
    const key = `${team.abbrev}-${season}`;

    let roster = cache[key];
    if (!roster) {
      const data = await get(`${STATS}/commonteamroster?TeamID=${team.id}&Season=${season}`);
      if (!data) {
        // One missing season is a small hole; stopping loses the whole run.
        console.log(`    ${season}: gave up`);
        missed++;
        continue;
      }
      const rs = data.resultSets[0];
      roster = rs.rowSet.map((r) => ({
        id: String(cell(rs, r, "PLAYER_ID")),
        name: cell(rs, r, "PLAYER"),
        birth: cell(rs, r, "BIRTH_DATE"),
      })).filter((p) => p.name);
      cache[key] = roster;
      await sleep(GAP_MS);
    }

    for (const p of roster) {
      const existing = players.get(p.id);
      if (existing) { existing.clubIds.add(team.abbrev); continue; }
      // "JUL 23, 1968" — the year is the only part the label uses.
      const year = Number(String(p.birth ?? "").match(/(\d{4})/)?.[1]);
      players.set(p.id, {
        id: p.id,
        name: p.name,
        birthYear: Number.isFinite(year) ? year : undefined,
        clubIds: new Set([team.abbrev]),
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
await writeFile(new URL("../data/nba-dataset.json", import.meta.url), JSON.stringify(dataset));

console.log(`\nWrote ${dataset.players.length} players across ${dataset.clubs.length} teams.`);
if (missed) console.log(`${missed} team-seasons could not be fetched — re-run to fill them in.`);
console.log("Logos: ./footfinder.sh nba-crests");
