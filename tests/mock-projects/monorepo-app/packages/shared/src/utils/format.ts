export function formatOrderTotal(totalCents: number, currency = 'USD'): string {
  return `${currency} ${(totalCents / 100).toFixed(2)}`;
}
