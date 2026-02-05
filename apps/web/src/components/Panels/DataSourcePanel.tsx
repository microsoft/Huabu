import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { SidebarPanel } from './SidebarPanel';

interface DataSourcePanelProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

export const DataSourcePanel = ({
  isCollapsed,
  onToggle,
}: DataSourcePanelProps) => {
  return (
    <SidebarPanel
      title="Data"
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen size={20} />}
      iconExpanded={<PanelLeftClose size={20} />}
    >
      {/* Data Source content would go here */}
    </SidebarPanel>
  );
};
