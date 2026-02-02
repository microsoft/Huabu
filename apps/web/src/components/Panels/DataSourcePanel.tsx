import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface DataSourcePanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const DataSourcePanel = ({
  isCollapsed,
  onToggle,
}: DataSourcePanelProps) => {
  if (isCollapsed) {
    return (
      <div
        style={{
          height: '100%',
          backgroundColor: '#f9fafb',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: '10px',
        }}
      >
        <button
          onClick={onToggle}
          title="Open Data Source"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: '8px',
          }}
        >
          <PanelLeftOpen size={20} />
        </button>
        <span
          style={{
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            marginTop: '10px',
            fontSize: '12px',
            fontWeight: 600,
            color: '#666',
            userSelect: 'none',
          }}
        >
          Data
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        backgroundColor: '#f9fafb',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: '40px',
          borderBottom: '1px solid #eee',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          background: '#fff',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          Data Sources
        </span>
        <button
          onClick={onToggle}
          title="Close Data Source"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <PanelLeftClose size={20} />
        </button>
      </div>
      <div style={{ padding: '16px' }}>
        <h3 style={{ margin: '0 0 16px', fontWeight: 600 }}>Data Sources</h3>
      </div>
    </div>
  );
};
