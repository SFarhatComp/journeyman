/**
 * The socket boundary: validation on the way in, and the single definition of
 * what a client is allowed to see on the way out.
 */

export const MAX_MESSAGE_BYTES = 4096;
export const MAX_NICKNAME_LENGTH = 24;

const VALIDATORS = {
  join: (p) => typeof p?.nickname === "string"
    && p.nickname.trim().length > 0
    && p.nickname.length <= MAX_NICKNAME_LENGTH,
  start: () => true,
  endGame: () => true,
  playAgain: () => true,
  pickClub: (p) => typeof p?.clubId === "string" && p.clubId.length <= 32,
  submitAnswer: (p) => typeof p?.entityId === "string" && p.entityId.length <= 32,
  search: (p) => typeof p?.query === "string" && p.query.length <= 64,
};

export function parseMessage(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) {
    return { error: "too_large" };
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { error: "bad_json" };
  }
  const validate = VALIDATORS[msg?.type];
  if (!validate) return { error: "unknown_type" };
  if (!validate(msg.payload)) return { error: "bad_payload" };
  return { type: msg.type, payload: msg.payload ?? {} };
}

/**
 * What one player may see. Answers stay hidden until REVEAL — knowing what a
 * rival typed would let you copy it or dodge their claim.
 */
export function snapshotFor(state, playerId) {
  const base = {
    code: state.code,
    phase: state.phase,
    config: state.config,
    phaseEndsAt: state.phaseEndsAt,
    hostId: state.hostId,
    you: playerId,
    players: state.players.map((p) => ({ id: p.id, nickname: p.nickname, score: p.score, connected: p.connected })),
  };
  if (state.phase === "FINAL") return { ...base, standings: state.standings };
  if (!state.round) return base;

  const round = {
    number: state.round.number,
    picks: state.round.picks, // club lock-out must be visible to everyone
    answered: Object.fromEntries(Object.keys(state.round.answers).map((id) => [id, true])),
    myGraceEndsAt: state.round.grace[playerId] ?? null,
  };
  if (state.phase === "REVEAL") {
    round.results = state.round.results;
    round.bestAnswer = state.round.bestAnswer;
  }
  return { ...base, round };
}
