const $ = (id) => document.getElementById(id);
const screens = ["home", "lobby", "picking", "answering", "reveal", "final"];

let ws, me = null, snap = null, clubs = [], lastRound = null, lastPicks = null;
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
function notice(msg) {
  const el = $("notice");
  el.textContent = msg;
  el.hidden = !msg;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 6000);
}

function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
}

async function connect(code, nickname) {
  saved("code", code);
  saved("nickname", nickname);
  clubs = await (await fetch("/api/clubs")).json();
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
    if (type === "error") notice(payload.error.replace(/_/g, " "));
  };

  ws.onclose = (e) => {
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

function render() {
  if (!snap) return;
  $("phase").textContent = snap.phase.toLowerCase();
  $("room-code").textContent = snap.code;

  // A new round means a fresh answer: leaving last round's name in the box
  // reads as though it were already submitted.
  if (snap.round && snap.round.number !== lastRound) {
    lastRound = snap.round.number;
    $("answer").value = "";
    $("answer").disabled = false;
    $("suggestions").innerHTML = "";
    $("answer-status").textContent = "";
  }

  renderScoreboard();

  if (snap.phase === "LOBBY") {
    show("lobby");
    $("lobby-players").innerHTML = snap.players.map((p) => `<li>${esc(p.nickname)}</li>`).join("");
    $("start").hidden = snap.you !== snap.hostId || snap.players.length < 2;
  }
  if (snap.phase === "PICKING") {
    show("picking");
    // Rebuilding 97 cards is expensive, so only do it when the pick set
    // actually changed — not on every snapshot that happens to arrive.
    const sig = JSON.stringify(snap.round.picks);
    if (sig !== lastPicks) { lastPicks = sig; renderClubs(); }
  } else {
    lastPicks = null; // next round starts from a fresh grid
  }
  if (snap.phase === "ANSWERING") { show("answering"); renderRoundClubs(); renderSubmitted(); }
  if (snap.phase === "REVEAL") { show("reveal"); renderResults(); }
  if (snap.phase === "FINAL") {
    show("final");
    $("standings").innerHTML = snap.standings
      .map((p) => `<li>${esc(p.nickname)} — <span class="pts">${p.score}</span></li>`).join("");
    // Host restarts; everyone else is told who they are waiting on, so the
    // screen never looks like a dead end.
    const host = snap.players.find((p) => p.id === snap.hostId);
    const iAmHost = snap.you === snap.hostId;
    $("play-again").hidden = !iAmHost;
    $("final-note").textContent = iAmHost
      ? "Starting again returns everyone to the lobby, so new players can join."
      : `Waiting for ${host ? host.nickname : "the host"} to start another game.`;
  }
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
  const taken = snap.round.picks;
  const mine = taken[snap.you];

  // clubs arrives pre-sorted by league then name, so a header goes in wherever
  // the league changes — no client-side grouping or sorting needed.
  let league = null;
  $("club-grid").innerHTML = clubs.map((c) => {
    const header = c.league !== league ? `<h3 class="league">${esc(c.league ?? "")}</h3>` : "";
    league = c.league;
    const byOther = Object.entries(taken).find(([pid, cid]) => cid === c.id && pid !== snap.you);
    const owner = byOther && snap.players.find((p) => p.id === byOther[0]);
    // loading="lazy" matters: 97 crests is ~1.5MB, and only a handful are on
    // screen at once under a 15-second timer.
    return `${header}<button class="club ${mine === c.id ? "mine" : ""}" data-id="${c.id}" ${byOther ? "disabled" : ""}>
      <img src="/crests/${c.id}.png" alt="" loading="lazy" decoding="async">
      <span class="nm">${esc(c.name)}</span>
      ${byOther ? `<span class="lock">taken by<b>${esc(owner ? owner.nickname : "someone")}</b></span>` : ""}
    </button>`;
  }).join("");
}

// Who has locked an answer in. The snapshot gives THAT they answered, never
// what — showing the pick would hand rivals the answer and break the race.
function renderSubmitted() {
  $("submitted").innerHTML = snap.players
    .map((p) => {
      const done = !!snap.round.answered[p.id];
      const me = p.id === snap.you;
      return `<li class="${done ? "done" : ""}${me ? " me" : ""}">${esc(p.nickname)}</li>`;
    }).join("");
}

function renderRoundClubs() {
  $("round-no").textContent = `Round ${snap.round.number} of ${snap.config.rounds ?? "?"}`;
  // Attribute each club to whoever claimed it — knowing Sam took Juventus is
  // half the fun, and it makes the round's set easier to hold in your head.
  const who = (pid) => snap.players.find((p) => p.id === pid);
  $("round-clubs").innerHTML = Object.entries(snap.round.picks)
    .map(([pid, cid]) => {
      const club = clubs.find((c) => c.id === cid);
      const player = who(pid);
      const mine = pid === snap.you;
      const owner = player ? esc(player.nickname) : "?";
      return `<li>
        <img src="/crests/${cid}.png" alt="" decoding="async">
        <span class="cn">${esc(club?.name ?? cid)}</span>
        <span class="owner">${mine ? "you" : owner}</span>
      </li>`;
    }).join("");
  const answered = snap.round.answered[snap.you];
  $("answer").disabled = !!answered;
  $("answer-status").textContent = answered ? "Answer locked in." : "";
}

function renderResults() {
  const name = (id) => esc(snap.players.find((p) => p.id === id)?.nickname ?? id);
  const clubName = (id) => clubs.find((c) => c.id === id)?.name ?? id;

  $("results").innerHTML = [...snap.round.results]
    .sort((a, b) => b.points - a.points)
    .map((r) => {
      const chose = r.entityLabel
        ? `<span class="chose">${esc(r.entityLabel)}</span>`
        : `<span class="chose none">no answer</span>`;
      // Which clubs the pick actually covered — the reason for the score.
      const hit = r.matchedClubIds.length
        ? `<span class="hit">${r.matchedClubIds.map(clubName).map(esc).join(", ")}</span>`
        : "";
      return `<li class="${r.points > 0 ? "scored" : ""}"><strong>${name(r.playerId)}</strong> <span class="pts">${r.points}</span><br>${chose}${hit ? "<br>" + hit : ""}</li>`;
    }).join("");
  const best = snap.round.bestAnswer;
  $("best-answer").textContent = best
    ? `Best possible: ${best.name} (${best.points})`
    : "No player in the dataset covered any of these clubs.";
}

// Countdown ticks locally between snapshots so it looks smooth. A personal
// grace window (granted when your claim lost a race) extends past the phase
// deadline, so show that instead when you have one.
setInterval(() => {
  if (!snap?.phaseEndsAt) return ($("timer").textContent = "");
  const grace = snap.round?.myGraceEndsAt;
  const usingGrace = grace && grace > snap.phaseEndsAt;
  const left = Math.max(0, Math.ceil(((usingGrace ? grace : snap.phaseEndsAt) - Date.now()) / 1000));
  $("timer").textContent = usingGrace ? `${left}+` : String(left);
  $("timer").classList.toggle("urgent", left <= 10 && snap.phase !== "REVEAL");
}, 250);

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
    const results = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
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
