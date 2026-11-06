/**
 * Summaries of order items ({ name: string, qty: number, price: number }).
 */

/** Total value of the items. */
export function total(items) {
  return items.reduce((sum, i) => sum + i.qty * i.price, 0);
}
