import React from 'react';
import BaseButton from './BaseButton';
import type { Product } from './ProductCard';

export interface ProductModalProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
}

export const ProductModal: React.FC<ProductModalProps> = ({ product, isOpen, onClose }) => {
  if (!isOpen || !product) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'white',
          padding: '24px',
          borderRadius: '8px',
          width: '400px',
          maxWidth: '90%',
        }}
      >
        <h2>{product.name}</h2>
        <p>Product ID: {product.id}</p>
        <p>Price: ${product.price.toFixed(2)}</p>
        <p>Status: {product.status}</p>
        <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
          <BaseButton variant="secondary" onClick={onClose}>
            Close
          </BaseButton>
        </div>
      </div>
    </div>
  );
};

export default ProductModal;
