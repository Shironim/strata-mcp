import React from 'react';
import type { PublicOrderSummary } from '@acme/shared';
import { OrderPanel } from './OrderPanel';

const initialOrders: PublicOrderSummary[] = [
  { id: 'ord-1', customerName: 'Ada Lovelace', totalCents: 4200, status: 'pending' },
];

export default function OrdersPage() {
  return (
    <main>
      <h1>Admin Orders</h1>
      <OrderPanel orders={initialOrders} />
    </main>
  );
}
