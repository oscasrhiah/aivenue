export interface Order { id: string; items: { sku: string; qty: number; price: number }[]; coupon?: string }

export function validateOrder(order: Order): string[] {
  const errors: string[] = [];
  if (!order.items.length) errors.push('empty order');
  for (const i of order.items) if (i.qty <= 0) errors.push(`bad qty for ${i.sku}`);
  return errors;
}
