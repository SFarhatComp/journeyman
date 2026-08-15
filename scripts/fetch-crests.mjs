/**
 * Download a club crest for each entry in data/clubs.json.
 *
 * The join is exact, with no name matching anywhere:
 *
 *   our QID -> Wikidata sitelink -> English Wikipedia article -> lead image
 *
 * A football club's article lead image is its crest, so this is deterministic.
 * (Wikidata's own P154 "logo" property was tried first and rejected: it is
 * sparse — Chelsea, Man United and Ajax have none — and sometimes wrong;
 * Barcelona's P154 is a photograph of their training ground.)
 *
 * Run: ./footfinder.sh crests
 *
 * Politeness: one request at a time, ~1s apart, Retry-After honoured. These
 * are free public endpoints and this is a personal project.
 *
 * Licensing note: many crests are served from wikipedia/en rather than
 * Commons, i.e. hosted under a fair-use rationale. Fine for a private game;
 * not something to redistribute publicly.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "footfinder/0.1 (personal football trivia game)";
const OUT = new URL("../public/crests/", import.meta.url);
const GAP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeFetch(url, accept) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...(accept && { Accept: accept }) } });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt;
      console.error(`       HTTP ${res.status}, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    return null; // 404 etc — caller reports it as a miss
  }
  return null;
}

/** One query for every sitelink, rather than 97 round trips. */
async function articleTitles(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = `SELECT ?club ?article WHERE {
    VALUES ?club { ${values} }
    ?article schema:about ?club ; schema:isPartOf <https://en.wikipedia.org/> .
  }`;
  const res = await politeFetch(
    `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`,
    "application/sparql-results+json",
  );
  if (!res) throw new Error("could not fetch sitelinks");
  const out = new Map();
  for (const b of (await res.json()).results.bindings) {
    const qid = b.club.value.split("/").pop();
    out.set(qid, decodeURIComponent(b.article.value.split("/wiki/").pop()));
  }
  return out;
}

/**
 * Use the thumbnail URL exactly as the API gives it.
 *
 * Do NOT rewrite the width. Files served from upload.wikimedia.org/wikipedia/en
 * — the fair-use, non-Commons ones, which most club crests are — only serve
 * widths that have already been rendered. Asking for any other size returns
 * HTTP 400, which silently cost every single crest on the first run.
 *
 * Sizes therefore vary (typically 200-330px). That is fine: the cards size
 * them with object-fit, and anything in that range is sharp at the ~96px
 * they display at.
 */
function crestUrl(thumb) {
  return thumb.split("?")[0]; // drop the API's utm tracking params
}

const clubs = JSON.parse(await readFile(new URL("../data/clubs.json", import.meta.url), "utf8"));
await mkdir(OUT, { recursive: true });

console.error(`Resolving ${clubs.length} article titles…`);
const titles = await articleTitles(clubs.map((c) => c.id));
console.error(`  ${titles.size}/${clubs.length} have an English Wikipedia article\n`);

const got = [];
const missed = [];

for (const [i, club] of clubs.entries()) {
  const title = titles.get(club.id);
  const label = `[${String(i + 1).padStart(2)}/${clubs.length}] ${club.name}`;

  if (!title) {
    missed.push({ ...club, reason: "no English Wikipedia article" });
    console.error(`  MISS ${label}: no article`);
    continue;
  }

  await sleep(GAP_MS);
  const summary = await politeFetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  );
  const thumb = summary && (await summary.json()).thumbnail?.source;

  if (!thumb) {
    missed.push({ ...club, reason: "article has no lead image" });
    console.error(`  MISS ${label}: no lead image`);
    continue;
  }

  await sleep(GAP_MS);
  const img = await politeFetch(crestUrl(thumb));
  if (!img) {
    missed.push({ ...club, reason: "image download failed" });
    console.error(`  MISS ${label}: download failed`);
    continue;
  }

  const bytes = Buffer.from(await img.arrayBuffer());
  await writeFile(new URL(`${club.id}.png`, OUT), bytes);
  got.push({ ...club, bytes: bytes.length, source: thumb.split("/").pop() });
  console.error(`  ok   ${label} — ${Math.round(bytes.length / 1024)}KB`);
}

console.error(`\n${got.length} crests, ${missed.length} missing`);
for (const m of missed) console.error(`  MISSING ${m.name}: ${m.reason}`);

// A contact sheet so every crest can be checked against its club name at a
// glance — an automated join is only trustworthy if someone eyeballs it once.
const cards = clubs
  .map((c) => {
    const ok = got.find((g) => g.id === c.id);
    return `<figure class="${ok ? "" : "miss"}">
      ${ok ? `<img src="/crests/${c.id}.png" alt="">` : `<div class="none">no crest</div>`}
      <figcaption>${c.name}<small>${c.league}</small></figcaption>
    </figure>`;
  })
  .join("\n");

await writeFile(
  new URL("../public/crest-check.html", import.meta.url),
  `<!doctype html><meta charset="utf-8"><title>Crest check</title>
<style>
 body{background:#111415;color:#e1e3e4;font:14px/1.4 system-ui;margin:0;padding:24px}
 h1{font-size:18px;margin:0 0 4px}p{color:#8b938d;margin:0 0 20px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px}
 figure{margin:0;background:#1d2021;border:1px solid #323536;border-radius:8px;padding:10px;text-align:center}
 figure.miss{border-color:#93000a}
 img{width:72px;height:72px;object-fit:contain;display:block;margin:0 auto 8px}
 .none{width:72px;height:72px;margin:0 auto 8px;display:flex;align-items:center;
       justify-content:center;color:#93000a;font-size:11px;border:1px dashed #93000a;border-radius:6px}
 figcaption{font-size:12px}small{display:block;color:#8b938d;font-size:10px;margin-top:2px}
</style>
<h1>Crest check — ${got.length}/${clubs.length}</h1>
<p>Every crest beside its club name. Anything mismatched should be obvious.</p>
<div class="grid">${cards}</div>`,
);

console.error("\nContact sheet: /crest-check.html");
