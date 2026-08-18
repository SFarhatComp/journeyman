const $ = (id) => document.getElementById(id);

// The only thing in the client that knows what sport it is. Everything else
// asks this, so adding a third sport is one entry rather than a search for
// the word "footballer".
const WORDS = {
  football: { player: "footballer", unit: "club", units: "clubs", verb: "played for" },
  hockey: { player: "hockey player", unit: "team", units: "teams", verb: "played for" },
};
const words = () => WORDS[snap?.config?.sport] ?? WORDS.football;
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const screens = ["home", "lobby", "picking", "answering", "reveal", "final"];

let ws, me = null, snap = null, clubs = [], lastRound = null, lastPicks = null, lastPhase = null;
// playerId, room code and nickname persist across a reload so the client can
// rejoin the same seat without the user retyping anything.
const saved = (k, v) => (v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v));

// Nicknames are user input rendered via innerHTML — escape them.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A banner outside every screen, so errors are visible in any phase. render()
// must never touch it, or a snapshot arriving in the same tick as an error
// would wipe the message before it is read.
let noticeTimer;
// The banner is red, because everything that used it was a failure. "Invite
// link copied" through a red bar reads as an error, so it takes a kind now.
function notice(msg, kind = "error", ms = 6000) {
  const el = $("notice");
  el.textContent = msg;
  el.hidden = !msg;
  el.className = kind;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, ms);
}

function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
}

async function connect(code, nickname) {
  saved("code", code);
  saved("nickname", nickname);
  // Deliberately not fetched here any more: which pool to fetch depends on the
  // room's sport, and that arrives with the first snapshot. Loading football's
  // 97 clubs before finding out the room is hockey wasted the request and
  // showed the wrong grid for a moment.
  const pid = saved("playerId") ?? "";
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?code=${code}&playerId=${pid}`);

  ws.onopen = () => notice("");

  ws.onmessage = (e) => {
    const { type, payload } = JSON.parse(e.data);
    if (type === "identity") {
      me = payload.playerId;
      saved("playerId", me);
      // Read the STORED nickname, not the input: after a reload the input is
      // empty, and an empty nickname fails validation with bad_payload.
      send("join", { nickname: saved("nickname") });
    }
    if (type === "snapshot") { snap = payload; render(); }
    if (type === "error") {
      if (payload.error === "already_claimed") {
        // The box still holds the name that was just refused. Leaving it there
        // means retyping over it under a clock, and it reads as though the
        // answer went through. Clear it and put the cursor back.
        $("answer").value = "";
        $("suggestions").innerHTML = "";
        $("answer").focus();
        answerNote = { text: `Someone already named that ${words().player}. Name a different one — you have extra time.`, cls: "taken" };
        renderAnswerNote();
        notice(`That ${words().player} is taken. Name someone else.`, "error", 15000);
      } else {
        notice(payload.error.replace(/_/g, " "));
      }
    }
  };

  ws.onclose = (e) => {
    if (ws === null) return; // we left on purpose
    // 4004 = no such room. Retrying would loop forever against a reaped room.
    if (e.code === 4004) {
      localStorage.clear();
      snap = null;
      notice("That room no longer exists.");
      return show("home");
    }
    $("phase").textContent = "reconnecting…";
    setTimeout(() => connect(saved("code"), saved("nickname")), 2000);
  };
}

const send = (type, payload = {}) => ws?.send(JSON.stringify({ type, payload }));

let clubsSport = null;
let clubsPending = null;
/**
 * Load the club pool for whatever sport this room is playing.
 *
 * Guarded on the sport rather than fired once, because the host can switch
 * sport in the lobby — and a hockey room showing 97 football clubs is not a
 * cosmetic problem, it is an unplayable grid.
 */
async function ensureClubs() {
  const sport = snap?.config?.sport ?? "football";
  if (clubsSport === sport || clubsPending === sport) return;
  clubsPending = sport;
  try {
    clubs = await (await fetch(`/api/clubs?sport=${sport}`)).json();
    clubsSport = sport;
    lastPicks = null; // the grid is built from a different pool now
    if (snap) render();
  } catch {
    notice("Could not load the teams. Check your connection.");
  } finally {
    clubsPending = null;
  }
}

function render() {
  if (!snap) return;
  ensureClubs();
  $("phase").textContent = snap.phase.toLowerCase();
  $("room-code").textContent = snap.code;

  // A new round means a fresh answer: leaving last round's name in the box
  // reads as though it were already submitted.
  if (snap.round && snap.round.number !== lastRound) {
    lastRound = snap.round.number;
    $("answer").value = "";
    $("answer").disabled = false;
    $("suggestions").innerHTML = "";
    $("club-search").value = ""; // a new round starts from the whole grid
    answerNote = null;
    $("answer-status").textContent = "";
  }

  renderScoreboard();

  if (snap.phase === "LOBBY") {
    show("lobby");
    renderSports();
    renderRounds();
    const min = snap.config?.minPlayers ?? 2;
    const max = snap.config?.maxPlayers ?? 8;
    $("lobby-count").textContent = `${snap.players.length} / ${max}`;
    $("lobby-players").innerHTML = snap.players.map((p) => `
      <li class="${p.connected ? "on" : "off"}${p.id === snap.you ? " me" : ""}">
        <span class="dot"></span>${esc(p.nickname)}
        ${p.id === snap.hostId ? '<span class="tag">host</span>' : ""}
        ${p.connected ? "" : '<span class="tag away">reconnecting</span>'}
      </li>`).join("");

    // The button reads minPlayers off the config rather than hardcoding 2, so
    // changing the engine default cannot leave the UI enforcing a stale rule.
    const iAmHost = snap.you === snap.hostId;
    const enough = snap.players.length >= min;
    $("start").hidden = !iAmHost || !enough;
    const host = snap.players.find((p) => p.id === snap.hostId);
    $("lobby-note").textContent = !enough
      ? `Waiting for ${min - snap.players.length} more player${min - snap.players.length === 1 ? "" : "s"}.`
      : iAmHost ? "" : `Waiting for ${host ? host.nickname : "the host"} to start.`;
  }
  if (snap.phase === "PICKING") {
    show("picking");
    renderPickStatus();
    $("pick-prompt").textContent = `Claim a ${words().unit}. Nobody can see what you take.`;
    // Rebuilding 97 cards is expensive. The grid now depends only on YOUR
    // pick, so other people choosing no longer redraws anything.
    const sig = snap.round.picks[snap.you] ?? "";
    if (sig !== lastPicks) { lastPicks = sig; renderClubs(); }
  } else {
    lastPicks = null; // next round starts from a fresh grid
  }
  if (snap.phase === "ANSWERING") { show("answering"); renderRoundClubs(); renderSubmitted(); renderNamedSoFar(); }
  if (snap.phase === "REVEAL") { show("reveal"); renderResults(); }
  if (snap.phase === "FINAL") {
    show("final");
    renderPodium();
    if (lastPhase !== "FINAL") confetti();
    // Host restarts; everyone else is told who they are waiting on, so the
    // screen never looks like a dead end.
    const host = snap.players.find((p) => p.id === snap.hostId);
    const iAmHost = snap.you === snap.hostId;
    $("play-again").hidden = !iAmHost;
    $("final-note").textContent = iAmHost
      ? "Starting again returns everyone to the lobby, so new players can join."
      : `Waiting for ${host ? host.nickname : "the host"} to start another game.`;
  }
  lastPhase = snap.phase;
}

function renderPodium() {
  // Competition ranking: equal scores share a rank. Rendering a tied winner as
  // "2nd" because the sort had to put someone second would be a visible lie,
  // and ties are common in an eight-round game scored 0-8.
  let rank = 0, prev = null;
  const ranked = snap.standings.map((p, i) => {
    if (p.score !== prev) { rank = i + 1; prev = p.score; }
    return { ...p, rank };
  });

  const top = ranked.slice(0, 3);
  // 2nd, 1st, 3rd — the shape of an actual podium. Filtered so a three-player
  // game does not render an empty plinth.
  $("podium").innerHTML = [1, 0, 2].filter((i) => top[i]).map((i) => {
    const p = top[i];
    return `<li class="p${p.rank}${p.id === snap.you ? " me" : ""}">
      <span class="nm">${esc(p.nickname)}</span>
      <span class="sc pts">${p.score}</span>
      <span class="block"><span class="rk">${p.rank}</span></span>
    </li>`;
  }).join("");

  $("standings").innerHTML = ranked.slice(3).map((p) => `
    <li class="${p.id === snap.you ? "me" : ""}">
      <span class="rk">${p.rank}</span>${esc(p.nickname)}
      <span class="pts">${p.score}</span>
    </li>`).join("");
}

// Pure CSS confetti: transform and opacity only, so it runs on the compositor
// and never touches layout. Thirty-six elements, removed after five seconds.
// A canvas library would be the obvious choice and costs several KB of JS on a
// screen that exists for eight seconds.
let confettiTimer = null;
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#ffe16d", "#a5d0b9", "#95d4b3", "#e1e3e4"];
  $("confetti").innerHTML = Array.from({ length: 36 }, () => {
    const c = colors[Math.floor(Math.random() * colors.length)];
    return `<i style="left:${(Math.random() * 100).toFixed(1)}%;background:${c};`
      + `animation-duration:${(2 + Math.random() * 1.5).toFixed(2)}s;`
      + `animation-delay:${(Math.random() * 1.2).toFixed(2)}s;`
      + `--r:${Math.round(Math.random() * 720 - 360)}deg"></i>`;
  }).join("");
  clearTimeout(confettiTimer);
  confettiTimer = setTimeout(() => { $("confetti").innerHTML = ""; }, 5000);
}

// Running totals, so players can see where they stand mid-game rather than
// only on the final screen.
function renderScoreboard() {
  const playing = snap.phase !== "HOME" && snap.phase !== "LOBBY";
  $("scoreboard").innerHTML = !playing ? "" : [...snap.players]
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const cls = [p.id === snap.you ? "me" : "", p.connected ? "" : "off"].filter(Boolean).join(" ");
      return `<li class="${cls}">${esc(p.nickname)}<span class="pts">${p.score}</span></li>`;
    }).join("");

  // Host only, and only while a game is actually running.
  $("end-game").hidden = !(playing && snap.phase !== "FINAL" && snap.you === snap.hostId);
}

function renderClubs() {
  // The snapshot only carries your own pick during PICKING, so there is no
  // lock state to render: every club stays takeable and nothing gives away
  // what anyone else has done.
  const mine = snap.round.picks[snap.you];

  // clubs arrives pre-sorted by league then name, so a header goes in wherever
  // the league changes — no client-side grouping or sorting needed.
  let league = null;
  $("club-grid").innerHTML = clubs.map((c) => {
    const header = c.league !== league ? `<h3 class="league">${esc(c.league ?? "")}</h3>` : "";
    league = c.league;
    // loading="lazy" matters: 97 crests is ~1.5MB, and only a handful are on
    // screen at once.
    // data-s carries what the search matches against: name, league and
    // country, so "prem" or "esp" find things the name alone would not.
    const hay = `${c.name} ${c.league ?? ""} ${c.country ?? ""}`.toLowerCase();
    return `${header}<button class="club ${mine === c.id ? "mine" : ""}" data-id="${c.id}" data-s="${esc(hay)}">
      <img src="/crests/${c.id}.png" alt="" loading="lazy" decoding="async">
      <span class="nm">${esc(c.name)}</span>
    </button>`;
  }).join("");
  applyClubFilter(); // a rebuild drops the DOM the filter was applied to
}

// Host-only game length. Everyone sees the setting; only the host can move it,
// and only in the lobby — the engine enforces both, this just reflects them.
const ROUND_OPTIONS = [4, 6, 8];
const SPORT_LABELS = { football: "⚽ Football", hockey: "🏒 Hockey" };

// Populated from /api/sports, so a sport whose dataset failed to load never
// appears as a button that cannot work.
let sportsAvailable = ["football"];
fetch("/api/sports").then((r) => r.json()).then((s) => { sportsAvailable = s; })
  .catch(() => { /* keep the default */ });

function renderSports() {
  const iAmHost = snap.you === snap.hostId;
  const current = snap.config?.sport ?? "football";
  $("sports").innerHTML = sportsAvailable.map((s) =>
    `<button class="${s === current ? "on" : ""}" data-sport="${s}" ${iAmHost ? "" : "disabled"}>${SPORT_LABELS[s] ?? s}</button>`
  ).join("");
}

function renderRounds() {
  const iAmHost = snap.you === snap.hostId;
  const current = snap.config?.rounds;
  $("rounds").innerHTML = ROUND_OPTIONS.map((n) =>
    `<button class="${n === current ? "on" : ""}" data-rounds="${n}" ${iAmHost ? "" : "disabled"}>${n}</button>`
  ).join("");
}

// Filtering toggles a class on cards that are already in the DOM. Re-rendering
// the grid on every keystroke would rebuild 97 nodes and restart 97 image
// loads, which is exactly the cost the pick phase cannot afford.
function applyClubFilter() {
  const q = $("club-search").value.trim().toLowerCase();
  const grid = $("club-grid");
  grid.classList.toggle("filtering", q.length > 0);
  let shown = 0;
  for (const el of grid.children) {
    if (el.tagName !== "BUTTON") continue;
    const hide = q && !el.dataset.s.includes(q);
    el.classList.toggle("hide", !!hide);
    if (!hide) shown++;
  }
  $("club-empty").hidden = shown > 0;
}

function renderPickStatus() {
  $("pick-no").textContent = `Round ${snap.round.number} of ${snap.config.rounds ?? "?"}`;
  const total = snap.players.length;
  const done = snap.round.pickedCount ?? 0;
  // How many have chosen, never who or what. Enough to see the room moving.
  $("pick-progress").textContent = snap.round.picks[snap.you]
    ? `${done} of ${total} chosen`
    : `${done} of ${total} chosen — your turn`;
}

// Who has claimed whom, live. A footballer already claimed is rejected, so
// this cannot be copied off — all it does is stop people spending the round
// discovering by trial and error which names are gone.
function renderSubmitted() {
  $("submitted").innerHTML = snap.players
    .map((p) => {
      const done = !!snap.round.answered[p.id];
      const who = snap.round.claimed?.[p.id];
      const me = p.id === snap.you;
      return `<li class="${done ? "done" : ""}${me ? " me" : ""}">
        <span class="nk">${esc(p.nickname)}</span>
        <span class="an">${done ? esc(who ?? "answered") : "thinking…"}</span>
      </li>`;
    }).join("");
}

// Set when an answer is refused, cleared when the round moves on or the answer
// lands. Kept outside render() because a snapshot arrives immediately after the
// rejection and would otherwise wipe the only explanation on screen.
let answerNote = null;
function renderAnswerNote() {
  const el = $("answer-status");
  if (answerNote) {
    el.textContent = answerNote.text;
    el.className = answerNote.cls;
    return;
  }
  const answered = snap?.round?.answered?.[snap.you];
  el.textContent = answered ? "Answer locked in." : "";
  el.className = answered ? "locked" : "";
}

function renderNamedSoFar() {
  const names = snap.namedSoFar ?? [];
  const box = $("named-so-far");
  box.hidden = names.length === 0;
  if (names.length === 0) return;
  box.querySelector("summary").textContent = `Already named this game (${names.length})`;
  $("named-list").innerHTML = names.map((n) => `<li>${esc(n)}</li>`).join("");
}

function renderRoundClubs() {
  $("answer-prompt").textContent = `Name one ${words().player} who ${words().verb}`;
  $("answer").placeholder = `Search a ${words().player}`;
  $("round-no").textContent = `Round ${snap.round.number} of ${snap.config.rounds ?? "?"}`;

  // If two people picked the same club, one was moved. Say so plainly — the
  // club they are about to play is not the one they chose, and finding that
  // out by squinting at the list would feel like a bug.
  const moved = snap.round.myReassignment;
  const label = (id) => clubs.find((c) => c.id === id)?.name ?? id;
  $("reassigned").hidden = !moved;
  if (moved) {
    $("reassigned").textContent =
      `${label(moved.from)} was taken by someone else, so you were moved to ${label(moved.to)}.`;
  }
  // Attribute each club to whoever claimed it — knowing Sam took Juventus is
  // half the fun, and it makes the round's set easier to hold in your head.
  const who = (pid) => snap.players.find((p) => p.id === pid);
  const row = (cid, ownerLabel, cls = "") => {
    const club = clubs.find((c) => c.id === cid);
    return `<li class="${cls}">
      <img src="/crests/${cid}.png" alt="" decoding="async">
      <span class="cn">${esc(club?.name ?? cid)}</span>
      <span class="owner">${ownerLabel}</span>
    </li>`;
  };
  $("round-clubs").innerHTML = [
    ...Object.entries(snap.round.picks).map(([pid, cid]) => {
      const player = who(pid);
      return row(cid, pid === snap.you ? "you" : esc(player ? player.nickname : "?"));
    }),
    // Nobody picked these; they are in play to keep a small round hard.
    ...(snap.round.wildcards ?? []).map((cid) => row(cid, "random", "wild")),
  ].join("");
  const answered = snap.round.answered[snap.you];
  $("answer").disabled = !!answered;
  if (answered) answerNote = null; // it landed; the refusal no longer applies
  renderAnswerNote();
}

function renderResults() {
  const name = (id) => esc(snap.players.find((p) => p.id === id)?.nickname ?? id);
  const club = (id) => clubs.find((c) => c.id === id);
  // The round's clubs in pick order — every result is scored against this same
  // set, so showing it identically on each row makes the scores comparable at
  // a glance instead of a list of names to re-read.
  const roundClubs = [...Object.values(snap.round.picks), ...(snap.round.wildcards ?? [])];

  const strip = (matched) => {
    const hit = new Set(matched);
    return `<ul class="strip">${roundClubs.map((cid) => `
      <li class="${hit.has(cid) ? "hit" : "miss"}" title="${esc(club(cid)?.name ?? cid)}">
        <img src="/crests/${cid}.png" alt="${esc(club(cid)?.name ?? cid)}" decoding="async" loading="lazy">
      </li>`).join("")}</ul>`;
  };

  $("reveal-no").textContent = `Round ${snap.round.number} results`;

  const best = snap.round.bestAnswer;
  $("best-answer").innerHTML = best
    ? `<span class="lbl">Best possible answer</span>
       <strong class="who">${esc(best.name)}</strong>
       <span class="max">${best.points} of ${roundClubs.length}</span>
       ${strip(best.matchedClubIds ?? [])}`
    : `<span class="lbl">Best possible answer</span>
       <strong class="who none">Nobody covered any of these clubs</strong>`;

  $("results").innerHTML = [...snap.round.results]
    .sort((a, b) => b.points - a.points)
    .map((r) => {
      const chose = r.entityLabel
        ? `<span class="chose">${esc(r.entityLabel)}</span>`
        : `<span class="chose none">no answer</span>`;
      return `<li class="${r.points > 0 ? "scored" : ""}${r.playerId === snap.you ? " me" : ""}">
        <div class="row">
          <strong>${name(r.playerId)}</strong>
          <span class="pts">${r.points > 0 ? "+" : ""}${r.points}</span>
        </div>
        ${chose}
        ${strip(r.matchedClubIds)}
      </li>`;
    }).join("");
}


// Countdown ticks locally between snapshots so it looks smooth. A personal
// grace window (granted when your claim lost a race) extends past the phase
// deadline, so show that instead when you have one.
setInterval(() => {
  const deadline = snap?.phaseEndsAt ?? null;
  const grace = snap?.round?.myGraceEndsAt ?? null;
  // Grace can outlive a deadline, and can now exist while there is no visible
  // deadline at all — the phase clock only arms when one player is left, but
  // losing a race for a footballer puts you on your own clock regardless.
  const usingGrace = grace !== null && (deadline === null || grace > deadline);
  const target = usingGrace ? grace : deadline;

  if (target === null) {
    // No clock while several players are still deciding. Clear the urgent
    // styling too, or it survives from the previous phase.
    $("timer").textContent = "";
    $("timer").classList.remove("urgent");
    return;
  }
  const left = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  $("timer").textContent = usingGrace ? `${left}+` : String(left);
  $("timer").classList.toggle("urgent", left <= 10 && snap.phase !== "REVEAL");
}, 250);

const preset = new URLSearchParams(location.search).get("room");
if (preset) {
  $("join-code").value = preset.toUpperCase().slice(0, 6);
  $("nickname").focus();
}

$("create").onclick = async () => {
  const nick = $("nickname").value.trim();
  if (!nick) return alert("Pick a name first");
  const { code } = await (await fetch("/api/room", { method: "POST" })).json();
  connect(code, nick);
};
$("join").onclick = () => {
  const nick = $("nickname").value.trim();
  if (!nick) return alert("Pick a name first");
  connect($("join-code").value.trim().toUpperCase(), nick);
};
// A shared link prefills the code, so joining is: open, type a name, tap Join.
$("share").onclick = async () => {
  const url = `${location.origin}/?room=${snap.code}`;
  try {
    if (navigator.share) return await navigator.share({ title: "FootFinder", text: `Join my room: ${snap.code}`, url });
    await navigator.clipboard.writeText(url);
    notice("Invite link copied.", "ok");
  } catch (err) {
    // Dismissing the share sheet rejects with AbortError. That is the user
    // saying no, not a failure — banner-ing the URL at them is the opposite
    // of what they asked for.
    if (err?.name === "AbortError") return;
    // No clipboard permission. Showing the link always works; the code is on
    // screen right above it anyway.
    notice(url, "ok");
  }
};
$("club-search").oninput = applyClubFilter;
$("sports").onclick = (e) => {
  const btn = e.target.closest("button[data-sport]");
  if (btn && !btn.disabled) send("setSport", { sport: btn.dataset.sport });
};
$("rounds").onclick = (e) => {
  const btn = e.target.closest("button[data-rounds]");
  if (btn && !btn.disabled) send("setRounds", { rounds: Number(btn.dataset.rounds) });
};
// Creating a room by misclick should not trap anyone in it. Closing the socket
// marks them disconnected, and an empty room is reaped a couple of minutes
// later — no new server message needed.
// The same handler on both screens. The lobby is not the only place you can
// be stuck: after a game ends, the only other control is host-only, so a
// non-host had no way out at all.
const leaveRoom = () => {
  if (snap && snap.phase !== "LOBBY" && !confirm("Leave the game?")) return;
  const sock = ws;
  ws = null;              // stop onclose from reconnecting us straight back in
  sock?.close();
  localStorage.clear();
  snap = null;
  lastRound = lastPicks = lastPhase = null;
  notice("");
  show("home");
};
$("leave").onclick = leaveRoom;
$("leave-final").onclick = leaveRoom;
$("start").onclick = () => send("start");
$("play-again").onclick = () => send("playAgain");
$("end-game").onclick = () => {
  if (confirm("End the game now and show final scores?")) send("endGame");
};
$("club-grid").onclick = (e) => {
  const btn = e.target.closest(".club");
  if (btn && !btn.disabled) send("pickClub", { clubId: btn.dataset.id });
};

let searchTimer;
$("answer").oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  if (q.length < 2) return ($("suggestions").innerHTML = "");
  searchTimer = setTimeout(async () => {
    const sport = snap?.config?.sport ?? "football";
    const results = await (await fetch(`/api/search?q=${encodeURIComponent(q)}&sport=${sport}`)).json();
    $("suggestions").innerHTML = results.map((r) => `<li data-id="${r.id}">${esc(r.label)}</li>`).join("");
  }, 150);
};
$("suggestions").onclick = (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  send("submitAnswer", { entityId: li.dataset.id });
  $("suggestions").innerHTML = "";
  $("answer").value = li.textContent;
};

// Rejoin automatically after a reload or a dropped connection: the room code
// and nickname are stored alongside the player id, so the server's reconnect
// path (same id -> same seat, score kept) can actually be reached.
if (saved("code") && saved("nickname")) connect(saved("code"), saved("nickname"));
else show("home");
