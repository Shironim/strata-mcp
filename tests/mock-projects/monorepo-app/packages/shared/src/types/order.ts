export type OrderStatus = 'pending' | 'paid' | 'cancelled';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface OrderDTO {
  id: string;
  customerName: string;
  totalCents: number;
  status: OrderStatus;
  internalNote?: string;
}

export type PublicOrderSummary = Omit<OrderDTO, 'internalNote'>;
