import React, { useState, Suspense } from 'react';
import * as UI from '../components';
import { BaseButton as ActionBtn } from '../components';
import type { Product } from '../components/ProductCard';

// Dynamic lazy import pattern
const ProductModal = React.lazy(() => import('../components/ProductModal'));

const INITIAL_PRODUCTS: Product[] = [
  { id: '1', name: 'Wireless Headphones', price: 99.99, status: 'in-stock' },
  { id: '2', name: 'Mechanical Keyboard', price: 149.5, status: 'low-stock' },
  { id: '3', name: 'Gaming Mouse', price: 59.0, status: 'out-of-stock' },
];

export const CatalogPage: React.FC = () => {
  const [products] = useState<Product[]>(INITIAL_PRODUCTS);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);

  const handleViewDetails = (product: Product) => {
    setSelectedProduct(product);
    setIsModalOpen(true);
  };

  const handleRefresh = () => {
    console.log('Refreshing catalog');
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1>Product Catalog (React)</h1>
        {/* Aliased component usage */}
        <ActionBtn variant="outline" onClick={handleRefresh}>
          Refresh Catalog
        </ActionBtn>
      </header>

      {/* Namespace component usage */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px' }}>
        {products.map((item) => (
          <UI.ProductCard
            key={item.id}
            product={item}
            onViewDetails={handleViewDetails}
          />
        ))}
      </div>

      <footer style={{ marginTop: '32px', textAlign: 'center' }}>
        <ActionBtn variant="secondary">
          Load More Products
        </ActionBtn>
      </footer>

      {/* Lazy component wrapped in Suspense */}
      <Suspense fallback={<div>Loading modal...</div>}>
        <ProductModal
          isOpen={isModalOpen}
          product={selectedProduct}
          onClose={() => setIsModalOpen(false)}
        />
      </Suspense>
    </div>
  );
};

export default CatalogPage;
