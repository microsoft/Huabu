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
      <h3 className="m-0 mb-4 font-semibold">Data Sources</h3>
      {/* Data Source content would go here */}
    </SidebarPanel>
  );
};
