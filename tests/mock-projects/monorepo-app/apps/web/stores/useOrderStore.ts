import type { OrderDTO } from '@acme/shared';

export function useOrderStore() {
  const state = {
    activeOrder: null as OrderDTO | null,
    isCancelling: false,
  };

  function setActiveOrder(order: OrderDTO) {
    state.activeOrder = order;
  }

  function markCancelled() {
    if (state.activeOrder) {
      state.activeOrder.status = 'cancelled';
    }
  }

  return { state, setActiveOrder, markCancelled };
}
