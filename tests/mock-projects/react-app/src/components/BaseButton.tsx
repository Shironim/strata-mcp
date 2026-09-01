import React from 'react';

export interface BaseButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline';
}

export const BaseButton: React.FC<BaseButtonProps> = ({
  variant = 'primary',
  children,
  style,
  ...props
}) => {
  const getStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      padding: '8px 16px',
      borderRadius: '4px',
      cursor: 'pointer',
      fontWeight: 500,
      border: 'none',
    };

    switch (variant) {
      case 'secondary':
        return { ...base, backgroundColor: '#4b5563', color: 'white' };
      case 'outline':
        return { ...base, backgroundColor: 'transparent', border: '1px solid #d1d5db', color: '#111827' };
      case 'primary':
      default:
        return { ...base, backgroundColor: '#2563eb', color: 'white' };
    }
  };

  return (
    <button style={{ ...getStyle(), ...style }} {...props}>
      {children}
    </button>
  );
};

export default BaseButton;
