// Stand-in for a payment SDK call.
export async function chargeCard(card: string, amount: number) { return { card, amount, id: 'ch_1' }; }
