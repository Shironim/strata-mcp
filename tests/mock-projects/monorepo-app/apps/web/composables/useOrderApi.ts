import type { OrderDTO } from '@acme/shared';

export function useOrderApi() {
  async function fetchOrder(id: string): Promise<OrderDTO> {
    const res = await fetch(`/api/orders/${id}`);
    return res.json() as Promise<OrderDTO>;
  }

  async function cancelOrder(id: string): Promise<void> {
    await fetch(`/api/orders/${id}/cancel`, { method: 'POST' });
  }

  return { fetchOrder, cancelOrder };
}
