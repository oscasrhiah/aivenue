import type { Order } from './validateOrder';
import { OrderService } from './OrderService';
import { chargeCard } from '../payments';

const service = new OrderService();

export async function placeOrder(order: Order, card: string) {
  const errors = service.validate(order);
  if (errors.length) return { ok: false, errors };
  const total = service.price(order);
  await chargeCard(card, total); // calls the payment SDK directly
  return { ok: true, total };
}
