import { PanelRightClose, PanelRightOpen } from 'lucide-react';

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
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
          title="Open AI Chat"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: '8px',
          }}
        >
          <PanelRightOpen size={20} />
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
          Chat
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
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>AI Chat</span>
        <button
          onClick={onToggle}
          title="Close AI Chat"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <PanelRightClose size={20} />
        </button>
      </div>
      <div style={{ padding: '16px' }}>
        <h3 style={{ margin: '0 0 16px', fontWeight: 600 }}>AI Chat</h3>
      </div>
    </div>
  );
};
