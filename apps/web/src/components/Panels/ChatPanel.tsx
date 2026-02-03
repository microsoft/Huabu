import { PanelRightClose, PanelRightOpen } from 'lucide-react';

import { SidebarPanel } from './SidebarPanel';

interface ChatPanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const ChatPanel = ({ isCollapsed, onToggle }: ChatPanelProps) => {
  return (
    <SidebarPanel
      title="Chat"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelRightOpen size={20} />}
      iconExpanded={<PanelRightClose size={20} />}
    ></SidebarPanel>
  );
};
