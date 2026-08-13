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

  let next = clone(state);
  next.round.picks[playerId] = clubId;

  const events = [{ type: "club_picked", playerId, clubId }];

  // Advance the moment everyone has acted — otherwise a room of fast players
  // watches a dead countdown every round.
  if (Object.keys(next.round.picks).length === next.players.length) {
    next = beginAnswering(next, now);
    events.push({ type: "phase_changed", phase: "ANSWERING" });
  }
  return ok(next, events);
}

function beginAnswering(state, now) {
  // Pure like every other state function here. Keeping one rule with no
  // exceptions is what stops the Task 7 class of bug recurring: no caller
  // has to know whether a helper mutates.
  const next = clone(state);
  next.phase = "ANSWERING";
  next.phaseEndsAt = now + next.config.answerSeconds * 1000;
  return next;
}

/** Assign a free club at random to each player who ran out of time. */
function autoAssign(state, deps) {
  const next = clone(state);
  const taken = new Set(Object.values(next.round.picks));
  const free = deps.clubs.filter((c) => !taken.has(c.id));
  const rand = deps.random ?? Math.random;

  for (const player of next.players) {
    if (next.round.picks[player.id]) continue;
    const idx = Math.floor(rand() * free.length);
    // splice, not index: the club must leave the pool so two players can
    // never be assigned the same one.
    const club = free.splice(idx, 1)[0];
    // startGame guarantees clubs.length >= players.length, so this holds.
    next.round.picks[player.id] = club.id;
  }
  return next;
}

export function submitAnswer(state, { playerId, entityId }, now, deps) {
  if (state.phase !== "ANSWERING") return fail(state, "wrong_phase");
  if (state.round.answers[playerId]) return fail(state, "already_answered");

  const claimed = Object.values(state.round.answers).some((a) => a.entityId === entityId);
  if (claimed) {
    // Losing a race by milliseconds must not cost the round, so the player is
    // given a personal extension to name someone else.
    const next = clone(state);
    next.round.grace[playerId] = now + next.config.graceSeconds * 1000;
    return { state: next, events: [{ type: "answer_rejected", playerId, entityId }], error: "already_claimed" };
  }

  let next = clone(state);
  next.round.answers[playerId] = { entityId, submittedAt: now };
  delete next.round.grace[playerId];

  const events = [{ type: "answer_accepted", playerId }];
  if (Object.keys(next.round.answers).length === next.players.length) {
    next = beginReveal(next, now, deps);
    events.push({ type: "phase_changed", phase: "REVEAL" });
  }
  return ok(next, events);
}

/** True while any player still has an unexpired grace window. */
function graceActive(state, now) {
  return Object.entries(state.round.grace).some(
    ([playerId, until]) => now < until && !state.round.answers[playerId],
  );
}

export function expirePhase(state, now, deps) {
  if (state.phaseEndsAt === null || now < state.phaseEndsAt) {
    // The deadline itself has not passed, but a grace window may have.
    return ok(state);
  }

  const next = clone(state);
  if (next.phase === "PICKING") {
    return ok(beginAnswering(autoAssign(next, deps), now), [
      { type: "phase_changed", phase: "ANSWERING" },
    ]);
  }

  if (next.phase === "ANSWERING") {
    if (graceActive(next, now)) return ok(state); // wait for the grace window
    return ok(beginReveal(next, now, deps), [{ type: "phase_changed", phase: "REVEAL" }]);
  }

  if (next.phase === "REVEAL") {
    next.history.push({ number: next.round.number, results: next.round.results });

    if (next.round.number >= next.config.rounds) {
      next.phase = "FINAL";
      next.phaseEndsAt = null;
      next.standings = [...next.players].sort((a, b) => b.score - a.score);
      return ok(next, [{ type: "game_over" }]);
    }
    // beginRound is pure, so its result is the state to return.
    return ok(beginRound(next, next.round.number + 1, now), [{ type: "phase_changed", phase: "PICKING" }]);
  }

  return ok(next);
}

/**
 * Score every answer, attach the best possible answer, enter REVEAL. Pure
 * like every other state helper: clones its input, never mutates it.
 */
export function beginReveal(state, now, deps) {
  const next = clone(state);
  const roundClubIds = Object.values(next.round.picks);
  const roundClubSet = new Set(roundClubIds);

  next.round.results = next.players.map((player) => {
    const answer = next.round.answers[player.id];
    if (!answer) {
      return { playerId: player.id, entityId: null, points: 0, matchedClubIds: [] };
    }
    const clubIds = deps.getPlayerClubs(answer.entityId);
    // Two spells at one club is still one club: dedupe the matched set.
    const matchedClubIds = [...new Set(clubIds.filter((c) => roundClubSet.has(c)))];
    return { playerId: player.id, entityId: answer.entityId, points: matchedClubIds.length, matchedClubIds };
  });

  for (const result of next.round.results) {
    const player = next.players.find((p) => p.id === result.playerId);
    player.score += result.points;
  }

  // Shown so every round teaches something, and so the game can prove the
  // round was winnable.
  next.round.bestAnswer = deps.findBest(roundClubIds);

  next.phase = "REVEAL";
  next.phaseEndsAt = now + next.config.revealSeconds * 1000;
  return next;
}

export function disconnect(state, playerId) {
  const next = clone(state);
  const player = next.players.find((p) => p.id === playerId);
  if (!player) return ok(next);
  player.connected = false; // score retained; phases advance without them
  return ok(next, [{ type: "player_disconnected", playerId }]);
}
