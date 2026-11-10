import { describe, expect, it } from 'bun:test';
import { extractReactContract } from '../../src/engine/parsers/contract-react';
import { extractStateDependencies } from '../../src/engine/parsers/state-dependency';
import { mapSourceFile } from '../../src/engine/source-map';
import { readSourceRef } from '../../src/engine/source-file';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SourceSnapshot } from '../../src/types';

describe('React Framework Engine (React 18 & 19)', () => {
  // ==========================================
  // 1. Contract Extraction & HOCs (R02)
  // ==========================================
  describe('Contract Extraction & HOC Unwrapping', () => {
    it('extracts props, defaults, emits, and slots from standard functional component', async () => {
      const code = `
import React from 'react';

export interface CardProps {
  title: string;
  variant?: 'elevated' | 'outlined' | 'flat';
  disabled?: boolean;
  onSelect?: (id: string) => void;
  children?: React.ReactNode;
}

export function Card({
  title,
  variant = 'elevated',
  disabled = false,
  onSelect,
  children
}: CardProps) {
  return (
    <div className={variant}>
      <h2>{title}</h2>
      <button disabled={disabled} onClick={() => onSelect?.(title)}>Select</button>
      <div>{children}</div>
    </div>
  );
}
`;
      const contract = await extractReactContract('/workspace/src/Card.tsx', code);
      expect(contract.component).toBe('Card');
      expect(contract.framework).toBe('react');

      // Title prop
      const titleProp = contract.props.find(p => p.name === 'title');
      expect(titleProp).toBeDefined();
      expect(titleProp?.required).toBe(true);
      expect(titleProp?.type).toBe('string');

      // Variant prop with default
      const variantProp = contract.props.find(p => p.name === 'variant');
      expect(variantProp).toBeDefined();
      expect(variantProp?.default).toBe("'elevated'");
      expect(variantProp?.required).toBe(false);
      expect(variantProp?.isUnion).toBe(true);

      // Disabled prop with default
      const disabledProp = contract.props.find(p => p.name === 'disabled');
      expect(disabledProp?.default).toBe('false');
      expect(disabledProp?.required).toBe(false);

      // Emits
      const onSelectEmit = contract.emits.find(e => e.name === 'onSelect');
      expect(onSelectEmit).toBeDefined();

      // Slots
      expect(contract.slots).toContain('default');
    });

    it('unwraps nested memo(forwardRef(...)) and extracts imperative exposed methods', async () => {
      const code = `
import React, { memo, forwardRef, useImperativeHandle, useRef } from 'react';

export interface InputProps {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  placeholder?: string;
  onChange?: (val: string) => void;
}

export interface InputHandle {
  focus: () => void;
  reset: () => void;
}

export const Input = memo(
  forwardRef<InputHandle, InputProps>(({ size = 'md', label, placeholder = 'Search...', onChange }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      reset: () => { if (inputRef.current) inputRef.current.value = ''; }
    }));

    return (
      <div>
        <label>{label}</label>
        <input ref={inputRef} placeholder={placeholder} onChange={(e) => onChange?.(e.target.value)} />
      </div>
    );
  })
);
`;
      const contract = await extractReactContract('/workspace/src/Input.tsx', code);
      expect(contract.component).toBe('Input');

      // Props extracted from inner forwardRef generic or parameter
      const sizeProp = contract.props.find(p => p.name === 'size');
      expect(sizeProp).toBeDefined();
      expect(sizeProp?.default).toBe("'md'");

      const placeholderProp = contract.props.find(p => p.name === 'placeholder');
      expect(placeholderProp?.default).toBe("'Search...'");

      const labelProp = contract.props.find(p => p.name === 'label');
      expect(labelProp?.required).toBe(true);

      // Exposed imperative methods
      expect(contract.exposed).toBeDefined();
      expect(contract.exposed).toContain('focus');
      expect(contract.exposed).toContain('reset');
    });

    it('resolves type alias with intersection types and render props', async () => {
      const code = `
import React from 'react';

interface BaseProps {
  id: string;
  className?: string;
}

type ModalProps = BaseProps & {
  isOpen: boolean;
  header?: React.ReactNode;
  renderFooter?: (onClose: () => void) => JSX.Element;
  onClose: () => void;
};

export default function Modal({ id, className, isOpen, header, renderFooter, onClose }: ModalProps) {
  return (
    <dialog open={isOpen}>
      <header>{header}</header>
      {renderFooter && renderFooter(onClose)}
    </dialog>
  );
}
`;
      const contract = await extractReactContract('/workspace/src/Modal.tsx', code);
      expect(contract.props.some(p => p.name === 'id')).toBe(true);
      expect(contract.props.some(p => p.name === 'className')).toBe(true);
      expect(contract.props.some(p => p.name === 'isOpen')).toBe(true);

      // Slots from render props
      expect(contract.slots).toContain('header');
      expect(contract.slots).toContain('renderFooter');

      const footerSlot = contract.slotDetails?.find(s => s.name === 'renderFooter');
      expect(footerSlot?.isScoped).toBe(true);
    });
  });

  // ==========================================
  // 4. State & Context Tracking (R04)
  // ==========================================
  describe('State & Context Tracking (React 19, Jotai, Zustand)', () => {
    it('tracks React 19 use(Context) and access mode correctly', () => {
      const code = `
import React, { use } from 'react';
import { ThemeContext } from './ThemeContext';

export function ThemeHeader() {
  const theme = use(ThemeContext);
  return <div style={{ color: theme.color }}>Header</div>;
}
`;
      const result = extractStateDependencies(code, 'react');
      expect(result.contexts).toContain('ThemeContext');
      const themeItem = result.items?.find(i => i.identifier === 'ThemeContext');
      expect(themeItem).toBeDefined();
      expect(themeItem?.accessMode).toBe('read');
    });

    it('tracks Jotai useAtom read and write access modes', () => {
      const code = `
import React from 'react';
import { useAtom } from 'jotai';
import { countAtom } from './store';

export function Counter() {
  const [count, setCount] = useAtom(countAtom);

  const increment = () => {
    setCount(c => c + 1);
  };

  return <button onClick={increment}>{count}</button>;
}
`;
      const result = extractStateDependencies(code, 'react');
      expect(result.stores).toContain('countAtom');

      const writeItem = result.items?.find(i => i.identifier === 'countAtom' && i.accessMode === 'write');
      expect(writeItem).toBeDefined();
    });
  });

  // ==========================================
  // 5. Source Map TSX/JSX Regions (R01)
  // ==========================================
  describe('Source Map TSX/JSX Regions', () => {
    it('maps components, hook calls, and JSX returns with exact source references', async () => {
      const tempDir = await fs.mkdtemp(join(tmpdir(), 'strata-react-map-'));
      const filePath = join(tempDir, 'Header.tsx');
      const code = `
import React, { useState } from 'react';

export function Header({ title }: { title: string }) {
  const [active, setActive] = useState(false);
  return (
    <header>
      <h1>{title}</h1>
      <button onClick={() => setActive(!active)}>Toggle</button>
    </header>
  );
}
`;
      await fs.writeFile(filePath, code, 'utf8');

      try {
        const result = await mapSourceFile(filePath);
        expect(result.framework).toBe('react');

        const symbols = result.regions.filter(r => r.kind === 'symbol');
        const headerSymbol = symbols.find(r => r.name === 'Header');
        expect(headerSymbol).toBeDefined();
        expect(headerSymbol?.attributes?.role).toBe('component');

        // Hook call region
        const hookRegion = headerSymbol?.children?.find(c => c.kind === 'hook-call');
        expect(hookRegion).toBeDefined();
        expect(hookRegion?.name).toBe('useState');

        // JSX region
        const jsxRegion = headerSymbol?.children?.find(c => c.kind === 'jsx');
        expect(jsxRegion).toBeDefined();

        const refSnippet = await readSourceRef(filePath, hookRegion!.ref);
        expect(refSnippet).toContain('useState(false)');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

