import { toCsv } from './csv.js';

/**
 * Summaries of order items ({ name: string, qty: number, price: number }).
 */

/** Total value of the items. */
export function total(items) {
  return items.reduce((sum, i) => sum + i.qty * i.price, 0);
}

/** Every item with its subtotal, then a TOTAL row, as CSV. */
export function summaryCsv(items) {
  const rows = items.map((i) => ({ name: i.name, qty: i.qty, price: i.price, subtotal: i.qty * i.price }));
  rows.push({ name: 'TOTAL', qty: null, price: null, subtotal: total(items) });
  return toCsv(rows, ['name', 'qty', 'price', 'subtotal']);
}
