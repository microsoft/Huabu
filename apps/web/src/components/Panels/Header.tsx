import React from 'react';

export const Header: React.FC = () => {
  return (
    <header
      style={{
        padding: '10px',
        borderBottom: '1px solid #ccc',
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
        background: '#fff',
        height: '60px',
        boxSizing: 'border-box',
      }}
    >
      <h2 style={{ margin: 0 }}>Sediment</h2>
    </header>
  );
};
