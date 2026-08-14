/**
 * Scoring. Pure set maths — no I/O, no dataset knowledge beyond the shape
 * `{ id, name, clubIds }`.
 *
 * A player's score for a round is simply how many of that round's chosen clubs
 * they played for. Because the round's clubs are distinct (taken clubs lock
 * out), the maximum equals the number of players.
 */

/** @returns {{points:number, matchedClubIds:string[]}} */
export function scoreAnswer(playerClubIds, roundClubIds) {
  const round = new Set(roundClubIds);
  // Set, not filter: two spells at one club is still one club.
  const matched = new Set();
  for (const id of playerClubIds) if (round.has(id)) matched.add(id);
  const matchedClubIds = [...matched];
  return { points: matchedClubIds.length, matchedClubIds };
}

/**
 * The best answer available in the dataset for this round. Shown at reveal so
 * every round teaches something, and so the game can prove it was winnable.
 * Linear over ~25k players — trivially fast at this scale.
 */
export function findBestAnswer(roundClubIds, allPlayers) {
  let best = null;
  for (const p of allPlayers) {
    const { points, matchedClubIds } = scoreAnswer(p.clubIds, roundClubIds);
    if (points === 0) continue;
    if (!best || points > best.points) {
      best = { entityId: p.id, name: p.name, points, matchedClubIds };
    }
  }
  return best;
}
