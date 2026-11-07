import { validateOrder, type Order } from './validateOrder';
import { priceOrder } from './priceOrder';

// Pass-through: every method forwards to a function with the same name.
export class OrderService {
  validate(order: Order) { return validateOrder(order); }
  price(order: Order) { return priceOrder(order); }
}
