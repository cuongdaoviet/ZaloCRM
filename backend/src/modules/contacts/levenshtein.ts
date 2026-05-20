/**
 * Capped Levenshtein distance (feature 0018, supports BR-0003 name_fuzzy).
 *
 * Returns the edit distance between `a` and `b`, but **early-exits** with the
 * cap+1 as soon as every cell in the current row exceeds the cap. The
 * scanner only cares about distances ≤ 2 (with cap 3 as a hard limit) so this
 * avoids paying for the full O(n*m) matrix on far-apart strings.
 *
 * Standard 2-row DP. Symmetric (`distance(a,b) === distance(b,a)`).
 */

export function levenshtein(a: string, b: string, cap = 3): number {
  // Length-difference lower bound: if the inputs differ in length by more than
  // the cap, the answer can't be ≤ cap. Short-circuit.
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter — saves memory on the running row
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const aLen = a.length;
  const bLen = b.length;

  let prev = new Array<number>(aLen + 1);
  let curr = new Array<number>(aLen + 1);
  for (let i = 0; i <= aLen; i++) prev[i] = i;

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    let rowMin = curr[0];
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= aLen; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      const del = prev[i] + 1;
      const ins = curr[i - 1] + 1;
      const sub = prev[i - 1] + cost;
      curr[i] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      if (curr[i] < rowMin) rowMin = curr[i];
    }
    // Early exit: every cell in this row is already > cap → answer > cap.
    if (rowMin > cap) return cap + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[aLen];
}
