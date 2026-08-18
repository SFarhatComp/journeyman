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
  setRounds: (p) => Number.isInteger(p?.rounds),
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
 * What one player may see.
 *
 * Answers used to stay hidden until REVEAL, to stop anyone copying a rival.
 * But a footballer already claimed is rejected outright, so copying was never
 * possible — hiding the claims only meant people spent their round discovering
 * by trial and error what was already gone. They are public as they land now,
 * and naming a duplicate is a mistake you can see yourself making.
 *
 * Club picks are hidden for the same reason, but only while PICKING: seeing
 * the grid fill up turns choosing into reacting to everyone else. From
 * ANSWERING onward the whole set is public, because it IS the round.
 */
export function snapshotFor(state, playerId) {
  const picking = state.phase === "PICKING";
  const answering = state.phase === "ANSWERING";
  // Both clocks start late, so both deadlines are withheld until they arm.
  const clockHidden = (picking && !state.round?.pickTimerArmed)
    || (answering && !state.round?.answerTimerArmed);
  const base = {
    code: state.code,
    phase: state.phase,
    config: state.config,
    // While picking, the deadline is a backstop nobody is meant to feel. It
    // becomes real, and visible, only once one player is left to choose.
    phaseEndsAt: clockHidden ? null : state.phaseEndsAt,
    hostId: state.hostId,
    you: playerId,
    players: state.players.map((p) => ({ id: p.id, nickname: p.nickname, score: p.score, connected: p.connected })),
  };
  // Footballers named in rounds that are over. Those were all revealed at the
  // time, so this leaks nothing — it just saves people burning a guess on a
  // name the room has already used.
  base.namedSoFar = (state.history ?? [])
    .flatMap((h) => h.results.map((r) => r.entityLabel).filter(Boolean));

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
    // Ownerless clubs that top a small round up. Withheld while picking, for
    // the same reason picks are: they are only chosen once picking ends, and
    // sending an empty list early would say "there are none" before that is
    // decided.
    wildcards: picking ? [] : (state.round.wildcards ?? []),
    answered: Object.fromEntries(Object.keys(state.round.answers).map((id) => [id, true])),
    // Who has claimed whom, as they claim them. An entity with no label
    // resolves to null rather than leaking a raw id.
    claimed: Object.fromEntries(
      Object.entries(state.round.answers).map(([id, a]) => [id, a.entityLabel ?? null]),
    ),
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
