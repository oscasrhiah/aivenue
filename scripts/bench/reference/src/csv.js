/** One CSV field: quoted when it holds a comma, a double quote or a newline; inner quotes doubled. */
function field(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (objects) as CSV: a header line with the column names, then one line per row. */
export function toCsv(rows, columns) {
  return [columns.map(field).join(','), ...rows.map((r) => columns.map((c) => field(r[c])).join(','))].join('\n');
}
