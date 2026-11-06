/** One CSV field: quoted when it holds a comma or a double quote. */
function field(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",]/.test(s) ? `"${s}"` : s;
}

/** Rows (objects) as CSV: a header line with the column names, then one line per row. */
export function toCsv(rows, columns) {
  return [columns.map(field).join(','), ...rows.map((r) => columns.map((c) => field(r[c])).join(','))].join('\n');
}
