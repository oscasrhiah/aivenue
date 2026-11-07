import type { Order } from './validateOrder';

export function priceOrder(order: Order): number {
  const subtotal = order.items.reduce((s, i) => s + i.qty * i.price, 0);
  return order.coupon === 'TEN' ? subtotal * 0.9 : subtotal;
}
