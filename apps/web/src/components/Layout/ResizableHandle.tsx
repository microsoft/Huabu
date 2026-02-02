import { Separator } from 'react-resizable-panels';

export const ResizableHandle = ({ className = '' }: { className?: string }) => {
  return (
    <Separator
      className={`${className}`}
      style={{
        width: '10px',
        background: '#f1f1f1',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        cursor: 'col-resize',
        borderLeft: '1px solid #e5e5e5',
        borderRight: '1px solid #e5e5e5',
      }}
    >
      <div
        style={{
          height: '20px',
          width: '4px',
          borderRadius: '2px',
          backgroundColor: '#d1d5db',
        }}
      />
    </Separator>
  );
};
