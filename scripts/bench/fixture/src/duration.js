const UNIT = { h: 3600, m: 60, s: 1 };

/**
 * Parse a duration such as "1h30m", "45s" or "2m5s" into seconds.
 * Returns NaN for text that is not a duration.
 */
export function parseDuration(text) {
  const s = String(text).trim();
  if (!/^(\d+[hms])+$/.test(s)) return NaN;
  // Read from the end: seconds, then minutes, then hours.
  const parts = [...s.matchAll(/(\d+)([hms])/g)].reverse();
  let total = 0;
  let mult = 1;
  for (const [, n] of parts) {
    total += Number(n) * mult;
    mult *= 60;
  }
  return total;
}

/** Format seconds as "1h30m", "2m5s", "45s" (no zero parts; "0s" for zero). */
export function formatDuration(seconds) {
  let left = Math.max(0, Math.floor(seconds));
  if (!left) return '0s';
  let out = '';
  for (const [unit, size] of Object.entries(UNIT)) {
    const n = Math.floor(left / size);
    if (n) out += `${n}${unit}`;
    left -= n * size;
  }
  return out;
}
