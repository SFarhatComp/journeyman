const $ = (id) => document.getElementById(id);
const screens = ["home", "lobby", "picking", "answering", "reveal", "final"];

let ws, me = null, snap = null, clubs = [];
// Survives a reload so refreshing rejoins as the same player.
const saved = (k, v) => (v === undefined ? sessionStorage.getItem(k) : sessionStorage.setItem(k, v));

function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
}

async function connect(code) {
  clubs = await (await fetch("/api/clubs")).json();
  const pid = saved("playerId") ?? "";
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?code=${code}&playerId=${pid}`);

  ws.onmessage = (e) => {
    const { type, payload } = JSON.parse(e.data);
    if (type === "identity") { me = payload.playerId; saved("playerId", me); send("join", { nickname: $("nickname").value.trim() }); }
    if (type === "snapshot") { snap = payload; render(); }
    if (type === "error") $("answer-status").textContent = payload.error.replace(/_/g, " ");
  };
  ws.onclose = () => { $("phase").textContent = "disconnected"; };
}

const send = (type, payload = {}) => ws?.send(JSON.stringify({ type, payload }));

function render() {
  if (!snap) return;
  $("phase").textContent = snap.phase.toLowerCase();
  $("room-code").textContent = snap.code;

  if (snap.phase === "LOBBY") {
    show("lobby");
    $("lobby-players").innerHTML = snap.players.map((p) => `<li>${p.nickname}</li>`).join("");
    $("start").hidden = snap.you !== snap.hostId || snap.players.length < 2;
  }
  if (snap.phase === "PICKING") { show("picking"); renderClubs(); }
  if (snap.phase === "ANSWERING") { show("answering"); renderRoundClubs(); }
  if (snap.phase === "REVEAL") { show("reveal"); renderResults(); }
  if (snap.phase === "FINAL") {
    show("final");
    $("standings").innerHTML = snap.standings.map((p) => `<li>${p.nickname} — <span class="pts">${p.score}</span></li>`).join("");
  }
}

function renderClubs() {
  const taken = snap.round.picks;
  const mine = taken[snap.you];
  $("club-grid").innerHTML = clubs.map((c) => {
    const takenByOther = Object.entries(taken).some(([pid, cid]) => cid === c.id && pid !== snap.you);
    return `<button class="club ${mine === c.id ? "mine" : ""}" data-id="${c.id}" ${takenByOther ? "disabled" : ""}>${c.name}</button>`;
  }).join("");
}

function renderRoundClubs() {
  const names = Object.values(snap.round.picks)
    .map((id) => clubs.find((c) => c.id === id)?.name ?? id);
  $("round-clubs").innerHTML = names.map((n) => `<li>${n}</li>`).join("");
  const answered = snap.round.answered[snap.you];
  $("answer").disabled = !!answered;
  $("answer-status").textContent = answered ? "Answer locked in." : "";
}

function renderResults() {
  const name = (id) => snap.players.find((p) => p.id === id)?.nickname ?? id;
  $("results").innerHTML = snap.round.results.map((r) =>
    `<li>${name(r.playerId)} — <span class="pts">${r.points}</span>${r.entityId ? "" : " (no answer)"}</li>`).join("");
  const best = snap.round.bestAnswer;
  $("best-answer").textContent = best
    ? `Best possible: ${best.name} (${best.points})`
    : "No player in the dataset covered any of these clubs.";
}

// Countdown ticks locally between snapshots so it looks smooth.
setInterval(() => {
  if (!snap?.phaseEndsAt) return ($("timer").textContent = "");
  const left = Math.max(0, Math.ceil((snap.phaseEndsAt - Date.now()) / 1000));
  $("timer").textContent = left;
}, 250);

$("create").onclick = async () => {
  if (!$("nickname").value.trim()) return alert("Pick a name first");
  const { code } = await (await fetch("/api/room", { method: "POST" })).json();
  connect(code);
};
$("join").onclick = () => {
  if (!$("nickname").value.trim()) return alert("Pick a name first");
  connect($("join-code").value.trim().toUpperCase());
};
$("start").onclick = () => send("start");
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
    $("suggestions").innerHTML = results.map((r) => `<li data-id="${r.id}">${r.label}</li>`).join("");
  }, 150);
};
$("suggestions").onclick = (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  send("submitAnswer", { entityId: li.dataset.id });
  $("suggestions").innerHTML = "";
  $("answer").value = li.textContent;
};

show("home");
