import React from 'react';
import BaseButton from './BaseButton';
import StatusBadge from './StatusBadge';

export interface Product {
  id: string;
  name: string;
  price: number;
  status: 'in-stock' | 'low-stock' | 'out-of-stock';
}

export interface ProductCardProps {
  product: Product;
  onViewDetails?: (product: Product) => void;
}

export const ProductCard: React.FC<ProductCardProps> = ({ product, onViewDetails }) => {
  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        padding: '16px',
        background: 'white',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{product.name}</h3>
        <StatusBadge status={product.status} />
      </div>
      <p style={{ fontSize: '18px', fontWeight: 700, margin: '12px 0' }}>
        ${product.price.toFixed(2)}
      </p>
      <BaseButton variant="primary" onClick={() => onViewDetails?.(product)}>
        View Details
      </BaseButton>
    </div>
  );
};

export default ProductCard;
