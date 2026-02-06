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
    // todo: change here
    <SidebarPanel
      title="Data Sources"
      tabs={
        <div className="cursor-pointer text-sm font-bold hover:text-blue-500"></div>
      }
      // todo: change here
      tools={<div>tool</div>}
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      iconCollapsed={<PanelLeftOpen />}
      iconExpanded={<PanelLeftClose />}
      className="border-border border-r"
    >
      {/* Data Source content would go here */}
    </SidebarPanel>
  );
};
