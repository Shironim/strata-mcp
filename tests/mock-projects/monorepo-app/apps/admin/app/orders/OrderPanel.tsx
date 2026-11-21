'use client';

import React from 'react';
import { ActionCard, type ActionCardProps } from '@acme/ui';
import type { PublicOrderSummary } from '@acme/shared';

export interface OrderPanelProps {
  orders: PublicOrderSummary[];
}

export function OrderPanel({ orders }: OrderPanelProps) {
  async function handleApprove(orderId: string) {
    await fetch(`/api/admin/orders/${orderId}/approve`, { method: 'POST' });
  }

  const sharedCardProps: Partial<ActionCardProps> = {
    highlight: true,
  };

  return (
    <div>
      {orders.map((order) => (
        <ActionCard
          key={order.id}
          id={order.id}
          customerName={order.customerName}
          totalCents={order.totalCents}
          status={order.status}
          onApprove={handleApprove}
          {...sharedCardProps}
        />
      ))}
    </div>
  );
}
