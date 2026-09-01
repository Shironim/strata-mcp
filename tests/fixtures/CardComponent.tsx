import React from 'react';

export interface CardProps {
  title: string;
  description?: string;
  count?: number;
  onAction?: (actionId: string) => void;
  children?: React.ReactNode;
}

export const CardComponent: React.FC<CardProps> = ({
  title,
  description,
  count = 0,
  onAction,
  children,
}) => {
  return (
    <div className="card">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      <span>Count: {count}</span>
      <button onClick={() => onAction?.('submit')}>Action</button>
      <div>{children}</div>
    </div>
  );
};
