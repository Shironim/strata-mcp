import { describe, expect, it } from 'bun:test';
import {
  extractComponentContract,
  extractComponentVariants,
  extractRenderBoundary,
  formatContractAsText,
} from '../../src/engine/contract';

describe('Design System Variants & RSC/SSR Boundary Violation Guard (Tahap 1)', () => {
  describe('CVA & Variant Schema Extraction', () => {
    it('extracts structured variants and defaultVariants from cva() definition', () => {
      const sampleCode = `
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva(
  'inline-flex items-center justify-center font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground',
        outline: 'border border-input bg-background hover:bg-accent',
        secondary: 'bg-secondary text-secondary-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);
      `;

      const result = extractComponentVariants(sampleCode, []);
      expect(result).toBeDefined();
      expect(result?.variants.variant).toEqual([
        'default',
        'destructive',
        'outline',
        'secondary',
        'ghost',
        'link',
      ]);
      expect(result?.variants.size).toEqual(['default', 'sm', 'lg', 'icon']);
      expect(result?.defaultVariants).toEqual({
        variant: 'default',
        size: 'default',
      });
    });

    it('falls back to extracting union string variants from props', () => {
      const props = [
        {
          name: 'variant',
          type: "'primary' | 'secondary' | 'outline' | 'ghost'",
          required: false,
        },
        {
          name: 'size',
          type: "'sm' | 'md' | 'lg'",
          required: false,
        },
      ];

      const result = extractComponentVariants('export const Button = () => {}', props);
      expect(result).toBeDefined();
      expect(result?.variants.variant).toEqual(['primary', 'secondary', 'outline', 'ghost']);
      expect(result?.variants.size).toEqual(['sm', 'md', 'lg']);
    });
  });

  describe('RSC & SSR Boundary Violation Detection', () => {
    it('flags error when React Server Component in app/ uses useState without use client', () => {
      const rscCode = `
import { useState } from 'react';

export default function ServerPage() {
  const [count, setCount] = useState(0);
  return <div>{count}</div>;
}
      `;

      const result = extractRenderBoundary('app/dashboard/page.tsx', rscCode, 'react');
      expect(result.boundary).toBe('server-component');
      expect(result.violations).toBeDefined();
      expect(result.violations?.some((v) => v.code === 'RSC_CLIENT_HOOK_IN_SERVER_COMPONENT')).toBe(
        true
      );
    });

    it('flags error when React Server Component attaches DOM onClick handler', () => {
      const rscCode = `
export default function ServerPage() {
  return <button onClick={() => console.log('click')}>Click</button>;
}
      `;

      const result = extractRenderBoundary('app/products/page.tsx', rscCode, 'react');
      expect(result.boundary).toBe('server-component');
      expect(result.violations).toBeDefined();
      expect(
        result.violations?.some((v) => v.code === 'RSC_EVENT_HANDLER_IN_SERVER_COMPONENT')
      ).toBe(true);
    });

    it('does not flag violations if file declares use client', () => {
      const clientCode = `
'use client';
import { useState } from 'react';

export default function ClientModal() {
  const [isOpen, setIsOpen] = useState(false);
  return <button onClick={() => setIsOpen(true)}>Open</button>;
}
      `;

      const result = extractRenderBoundary('app/components/ClientModal.tsx', clientCode, 'react');
      expect(result.boundary).toBe('client-component');
      expect(result.violations).toBeUndefined();
    });

    it('warns when Astro component mounts interactive components without client directives', () => {
      const astroCode = `
---
import ProductModal from '../components/ProductModal.vue';
---
<Layout>
  <ProductModal isOpen={false} />
</Layout>
      `;

      const result = extractRenderBoundary('src/pages/catalog.astro', astroCode, 'astro');
      expect(result.boundary).toBe('astro-static');
      expect(result.violations).toBeDefined();
      expect(
        result.violations?.some((v) => v.code === 'ASTRO_UNHYDRATED_INTERACTIVE_ISLAND')
      ).toBe(true);
    });
  });

  describe('Formatted Text Output with Variants and Violations', async () => {
    it('formats variants and boundary warnings cleanly', async () => {
      const contract = await extractComponentContract(
        'app/checkout/page.tsx',
        `
import { useState } from 'react';
import { cva } from 'class-variance-authority';

const badgeVariants = cva('badge', {
  variants: {
    status: { success: 'bg-green-500', error: 'bg-red-500' }
  },
  defaultVariants: { status: 'success' }
});

export default function Page() {
  const [data, setData] = useState(null);
  return <div>Checkout</div>;
}
        `
      );

      const text = formatContractAsText(contract);
      expect(text).toContain('Variants:');
      expect(text).toContain('status: ["success", "error"] (default: "success")');
      expect(text).toContain('Boundary Warnings / Violations:');
      expect(text).toContain('RSC_CLIENT_HOOK_IN_SERVER_COMPONENT');
    });
  });
});
