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
  state.phase = "PICKING";
  state.round = {
    number,
    picks: {}, // playerId -> clubId
    answers: {}, // playerId -> { entityId, submittedAt }
    grace: {}, // playerId -> deadline ms
    results: null,
    bestAnswer: null,
  };
  state.phaseEndsAt = now + state.config.pickSeconds * 1000;
  return state;
}
