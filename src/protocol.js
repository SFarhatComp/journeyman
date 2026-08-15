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
 *
 * Club picks are hidden for the same reason, but only while PICKING: seeing
 * the grid fill up turns choosing into reacting to everyone else. From
 * ANSWERING onward the whole set is public, because it IS the round.
 */
export function snapshotFor(state, playerId) {
  const picking = state.phase === "PICKING";
  const base = {
    code: state.code,
    phase: state.phase,
    config: state.config,
    // While picking, the deadline is a backstop nobody is meant to feel. It
    // becomes real, and visible, only once one player is left to choose.
    phaseEndsAt: picking && !state.round?.pickTimerArmed ? null : state.phaseEndsAt,
    hostId: state.hostId,
    you: playerId,
    players: state.players.map((p) => ({ id: p.id, nickname: p.nickname, score: p.score, connected: p.connected })),
  };
  if (state.phase === "FINAL") return { ...base, standings: state.standings };
  if (!state.round) return base;

  const mine = state.round.picks[playerId];
  const round = {
    number: state.round.number,
    // Own pick only while choosing; everyone's once the round is under way.
    picks: picking ? (mine ? { [playerId]: mine } : {}) : state.round.picks,
    // How many have chosen, without saying who or what — enough to know the
    // room is moving, not enough to shadow anyone's pick.
    pickedCount: Object.keys(state.round.picks).length,
    answered: Object.fromEntries(Object.keys(state.round.answers).map((id) => [id, true])),
    myGraceEndsAt: state.round.grace[playerId] ?? null,
    // Only your own collision. Telling you someone else was moved off a club
    // would leak the pick that the hiding is there to protect.
    myReassignment: state.round.reassigned?.[playerId] ?? null,
  };
  if (state.phase === "REVEAL") {
    round.results = state.round.results;
    round.bestAnswer = state.round.bestAnswer;
  }
  return { ...base, round };
}
