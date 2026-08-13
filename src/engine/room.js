/**
 * The room state machine. Pure: every mutator takes the current state and
 * returns a new one, never reads the clock (time arrives as `now`), and never
 * touches the dataset directly (it arrives as `deps`).
 *
 * That is what lets the claim race, the grace window and phase expiry be
 * tested exhaustively without sockets or waiting in real time.
 *
 * Phases: LOBBY -> PICKING -> ANSWERING -> REVEAL -> (PICKING | FINAL)
 */

export const DEFAULT_CONFIG = {
  rounds: 8,
  pickSeconds: 15,
  answerSeconds: 30,
  revealSeconds: 8,
  graceSeconds: 5,
  maxPlayers: 8,
  minPlayers: 2,
};

const clone = (state) => structuredClone(state);
const ok = (state, events = []) => ({ state, events });
const fail = (state, error) => ({ state, events: [], error });

export function createRoom({ code, config = {} }) {
  return {
    code,
    hostId: null,
    phase: "LOBBY",
    config: { ...DEFAULT_CONFIG, ...config },
    players: [],
    round: null,
    phaseEndsAt: null,
    history: [],
  };
}

export function addPlayer(state, { id, nickname }) {
  const next = clone(state);
  const existing = next.players.find((p) => p.id === id);

  if (existing) {
    // Reconnection: keep the score, mark them back online.
    existing.connected = true;
    return ok(next, [{ type: "player_reconnected", playerId: id }]);
  }
  if (next.players.length >= next.config.maxPlayers) return fail(state, "room_full");
  if (next.players.some((p) => p.nickname === nickname)) return fail(state, "nickname_taken");

  next.players.push({ id, nickname, score: 0, connected: true });
  if (!next.hostId) next.hostId = id;
  return ok(next, [{ type: "player_joined", playerId: id }]);
}

export function startGame(state, now, deps) {
  if (state.phase !== "LOBBY") return fail(state, "already_started");
  if (state.players.length < state.config.minPlayers) return fail(state, "not_enough_players");
  // Clubs lock out when taken, so every player needs one available.
  if (deps.clubs.length < state.players.length) return fail(state, "not_enough_clubs");

  const next = clone(state);
  return ok(beginRound(next, 1, now), [{ type: "game_started" }]);
}

/** Shared by startGame and the reveal->next-round transition. */
export function beginRound(state, number, now) {
  // Clones like every other mutator: this is exported, and a future caller
  // must not have to know it mutates. The extra clone costs nothing at this
  // scale and removes a live-state corruption waiting to happen.
  const next = clone(state);
  next.phase = "PICKING";
  next.round = {
    number,
    picks: {}, // playerId -> clubId
    answers: {}, // playerId -> { entityId, submittedAt }
    grace: {}, // playerId -> deadline ms
    results: null,
    bestAnswer: null,
  };
  next.phaseEndsAt = now + next.config.pickSeconds * 1000;
  return next;
}

export function pickClub(state, { playerId, clubId }, now, deps) {
  if (state.phase !== "PICKING") return fail(state, "wrong_phase");
  if (!deps.clubs.some((c) => c.id === clubId)) return fail(state, "unknown_club");

  const takenBy = Object.entries(state.round.picks).find(([pid, cid]) => cid === clubId && pid !== playerId);
  if (takenBy) return fail(state, "club_taken");

  const next = clone(state);
  next.round.picks[playerId] = clubId;

  const events = [{ type: "club_picked", playerId, clubId }];

  // Advance the moment everyone has acted — otherwise a room of fast players
  // watches a dead countdown every round.
  if (Object.keys(next.round.picks).length === next.players.length) {
    beginAnswering(next, now);
    events.push({ type: "phase_changed", phase: "ANSWERING" });
  }
  return ok(next, events);
}

function beginAnswering(state, now) {
  state.phase = "ANSWERING";
  state.phaseEndsAt = now + state.config.answerSeconds * 1000;
}

/** Assign a free club at random to a player who ran out of time. */
function autoAssign(state, deps) {
  const taken = new Set(Object.values(state.round.picks));
  const free = deps.clubs.filter((c) => !taken.has(c.id));
  const rand = deps.random ?? Math.random;

  for (const player of state.players) {
    if (state.round.picks[player.id]) continue;
    const idx = Math.floor(rand() * free.length);
    const club = free.splice(idx, 1)[0];
    // startGame guarantees clubs.length >= players.length, so this holds.
    state.round.picks[player.id] = club.id;
  }
}

export function expirePhase(state, now, deps) {
  if (state.phaseEndsAt === null || now < state.phaseEndsAt) return ok(state);

  const next = clone(state);
  if (next.phase === "PICKING") {
    autoAssign(next, deps);
    beginAnswering(next, now);
    return ok(next, [{ type: "phase_changed", phase: "ANSWERING" }]);
  }
  return ok(next);
}
