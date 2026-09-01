import React from 'react';

export interface StatusBadgeProps {
  status: 'in-stock' | 'low-stock' | 'out-of-stock';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const getStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: '12px',
      borderRadius: '9999px',
      fontWeight: 600,
    };

    switch (status) {
      case 'in-stock':
        return { ...base, backgroundColor: '#dcfce7', color: '#15803d' };
      case 'low-stock':
        return { ...base, backgroundColor: '#fef9c3', color: '#a16207' };
      case 'out-of-stock':
        return { ...base, backgroundColor: '#fee2e2', color: '#b91c1c' };
    }
  };

  return <span style={getStyle()}>{status.replace('-', ' ').toUpperCase()}</span>;
};

export default StatusBadge;
