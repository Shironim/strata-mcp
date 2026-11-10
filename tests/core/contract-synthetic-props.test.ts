import { describe, expect, it } from 'bun:test';
import { extractReactContract } from '../../src/engine/parsers/contract-react';

describe('Explicit props, unresolved inherited types and CVA variants', () => {
  it('extracts declared button bindings and CVA variants without fabricating inherited HTML props', async () => {
    const code = `
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-lg",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        outline: "border-border bg-background",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive text-destructive-foreground",
      },
      size: {
        default: "h-8 px-2.5",
        sm: "h-7 px-2",
        lg: "h-9 px-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <button className={className} {...props} />;
}
`;

    const contract = await extractReactContract('/src/components/ui/button.tsx', code);

    const propNames = contract.props.map((p) => p.name);
    expect(propNames).not.toContain('disabled');
    expect(propNames).not.toContain('type');
    expect(contract.unresolvedTypes?.some(item => item.name.includes('ButtonPrimitive.Props'))).toBe(true);
    expect(propNames).toContain('className');
    expect(propNames).toContain('variant');
    expect(propNames).toContain('size');

    const variantProp = contract.props.find((p) => p.name === 'variant')!;
    expect(variantProp.isUnion).toBe(true);
    expect(variantProp.unionMembers).toEqual(['default', 'outline', 'secondary', 'destructive']);
    expect(variantProp.default).toBe('"default"');

    const sizeProp = contract.props.find((p) => p.name === 'size')!;
    expect(sizeProp.isUnion).toBe(true);
    expect(sizeProp.unionMembers).toEqual(['default', 'sm', 'lg']);
    expect(sizeProp.default).toBe('"default"');
  });

  it('preserves unresolved InputHTMLAttributes and explicit local props', async () => {
    const code = `
import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export function Input({ error, className, ...props }: InputProps) {
  return <input className={className} {...props} />;
}
`;

    const contract = await extractReactContract('/src/components/ui/input.tsx', code);
    const propNames = contract.props.map((p) => p.name);
    expect(propNames).not.toContain('disabled');
    expect(propNames).not.toContain('placeholder');
    expect(propNames).not.toContain('value');
    expect(contract.unresolvedTypes?.some(item => item.name.includes('InputHTMLAttributes'))).toBe(true);
    expect(propNames).toContain('error');
    expect(propNames).toContain('className');
  });

  it('preserves explicitly declared HTML-named props and defaults', async () => {
    const contract = await extractReactContract('/src/Button.tsx', `
      interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
        disabled?: boolean;
        type?: 'button' | 'submit';
      }
      export function Button({ disabled = false, type = 'submit' }: Props) {
        return <button disabled={disabled} type={type}/>;
      }
    `);
    expect(contract.props.find(prop => prop.name === 'disabled')).toMatchObject({ type: 'boolean', default: 'false' });
    expect(contract.props.find(prop => prop.name === 'type')).toMatchObject({ default: "'submit'" });
    expect(contract.unresolvedTypes?.some(item => item.name.includes('ButtonHTMLAttributes'))).toBe(true);
  });

  it('extracts JSDoc description and @deprecated tags from prop signatures', async () => {
    const code = `
import React from 'react';

export interface CardProps {
  /**
   * Title text displayed in the header.
   */
  title: string;

  /**
   * The visual color scheme.
   * @deprecated Use 'tone' instead.
   */
  variant?: 'light' | 'dark';

  /**
   * Indicates if the card is loading.
   * @deprecated
   */
  isLoading?: boolean;
}

export function Card({ title, variant, isLoading }: CardProps) {
  return <div />;
}
`;

    const contract = await extractReactContract('/src/components/Card.tsx', code);
    const titleProp = contract.props.find((p) => p.name === 'title')!;
    expect(titleProp.description).toBe('Title text displayed in the header.');
    expect(titleProp.deprecated).toBeUndefined();

    const variantProp = contract.props.find((p) => p.name === 'variant')!;
    expect(variantProp.description).toBe('The visual color scheme.');
    expect(variantProp.deprecated).toBe("Use 'tone' instead.");

    const loadingProp = contract.props.find((p) => p.name === 'isLoading')!;
    expect(loadingProp.description).toBe('Indicates if the card is loading.');
    expect(loadingProp.deprecated).toBe(true);

    const { formatContractAsText } = await import('../../src/engine/contract');
    const text = formatContractAsText(contract);
    expect(text).toContain("⚠️ [DEPRECATED: Use 'tone' instead.] - The visual color scheme.");
    expect(text).toContain("⚠️ [DEPRECATED] - Indicates if the card is loading.");
    expect(text).toContain("- title: string (required) - Title text displayed in the header.");
  });
});
