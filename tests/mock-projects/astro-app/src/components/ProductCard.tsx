import React from 'react';

export interface Product {
  id: string;
  name: string;
  price: number;
  status: 'in-stock' | 'low-stock' | 'out-of-stock';
}

export interface ProductCardProps {
  product: Product;
}

export const ProductCard: React.FC<ProductCardProps> = ({ product }) => {
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
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            fontSize: '12px',
            borderRadius: '9999px',
            fontWeight: 600,
            backgroundColor: product.status === 'in-stock' ? '#dcfce7' : '#fee2e2',
            color: product.status === 'in-stock' ? '#15803d' : '#b91c1c',
          }}
        >
          {product.status.toUpperCase()}
        </span>
      </div>
      <p style={{ fontSize: '18px', fontWeight: 700, margin: '12px 0' }}>
        ${product.price.toFixed(2)}
      </p>
      <button
        style={{
          padding: '8px 16px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontWeight: 500,
          border: 'none',
          backgroundColor: '#2563eb',
          color: 'white',
        }}
        onClick={() => alert(`Clicked on ${product.name}`)}
      >
        View Details (React Island)
      </button>
    </div>
  );
};

export default ProductCard;
