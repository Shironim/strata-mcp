import React from 'react';
import { formatOrderTotal, type PublicOrderSummary } from '@acme/shared';

export interface ActionCardProps extends PublicOrderSummary {
  highlight?: boolean;
  onApprove: (orderId: string) => void;
}

export function ActionCard({
  id,
  customerName,
  totalCents,
  status,
  highlight = false,
  onApprove,
}: ActionCardProps) {
  return (
    <section data-highlight={highlight} data-status={status}>
      <h4>{customerName}</h4>
      <span>{formatOrderTotal(totalCents)}</span>
      <button type="button" onClick={() => onApprove(id)}>
        Approve
      </button>
    </section>
  );
}
