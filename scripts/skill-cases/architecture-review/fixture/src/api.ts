import type { Order } from './orders/validateOrder';

// A second copy of the pricing rule, drifted from priceOrder.ts.
export function quote(order: Order) {
  const subtotal = order.items.reduce((s, i) => s + i.qty * i.price, 0);
  return { total: order.coupon === 'TEN' ? Math.round(subtotal * 0.9) : subtotal };
}
