const $ = (id) => document.getElementById(id);
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
function notice(msg, kind = "error") {
  const el = $("notice");
  el.textContent = msg;
  el.hidden = !msg;
  el.className = kind;
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
  const club = (id) => clubs.find((c) => c.id === id);
  // The round's clubs in pick order — every result is scored against this same
  // set, so showing it identically on each row makes the scores comparable at
  // a glance instead of a list of names to re-read.
  const roundClubs = Object.values(snap.round.picks);

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
  if (!snap?.phaseEndsAt) return ($("timer").textContent = "");
  const grace = snap.round?.myGraceEndsAt;
  const usingGrace = grace && grace > snap.phaseEndsAt;
  const left = Math.max(0, Math.ceil(((usingGrace ? grace : snap.phaseEndsAt) - Date.now()) / 1000));
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
  } catch {
    // Cancelled share, or no clipboard permission. Showing the link is the
    // fallback that always works — the code is on screen above it anyway.
    notice(url, "ok");
  }
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
