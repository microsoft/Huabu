import React, { useRef, useState } from 'react';
import { Panel, Group } from 'react-resizable-panels';

import { ResizableHandle } from './ResizableHandle';

import type { PanelImperativeHandle } from 'react-resizable-panels';

interface MainLayoutProps {
  header: React.ReactNode;
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  children: React.ReactNode;
}

export const MainLayout = ({
  header,
  leftPanel,
  rightPanel,
  children,
}: MainLayoutProps) => {
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);

  const toggleLeftPanel = () => {
    const panel = leftPanelRef.current;
    if (panel) {
      if (isLeftCollapsed) {
        panel.expand();
      } else {
        panel.collapse();
      }
      setIsLeftCollapsed(!isLeftCollapsed);
    }
  };

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) {
      if (isRightCollapsed) {
        panel.expand();
      } else {
        panel.collapse();
      }
      setIsRightCollapsed(!isRightCollapsed);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Header Area */}
      <div className="shrink-0">{header}</div>

      {/* Main Content Area */}
      <Group className="h-full w-full">
        {/* Left Panel */}
        <Panel
          panelRef={leftPanelRef}
          defaultSize="15%"
          collapsible
          collapsedSize={isLeftCollapsed ? 48 : 200}
          minSize={isLeftCollapsed ? 48 : 200}
          maxSize={isLeftCollapsed ? 48 : '30%'}
        >
          {React.isValidElement(leftPanel)
            ? React.cloneElement(leftPanel as React.ReactElement<any>, {
                isCollapsed: isLeftCollapsed,
                onToggle: toggleLeftPanel,
              })
            : leftPanel}
        </Panel>

        <ResizableHandle className={'hidden'} />

        {/* Center Editor */}
        <Panel minSize={100}>{children}</Panel>

        <ResizableHandle className={'hidden'} />

        {/* Right Panel */}
        <Panel
          panelRef={rightPanelRef}
          defaultSize="30%"
          collapsible
          collapsedSize={isRightCollapsed ? 48 : 200}
          minSize={isRightCollapsed ? 48 : 200}
          maxSize={isRightCollapsed ? 48 : '50%'}
        >
          {React.isValidElement(rightPanel)
            ? React.cloneElement(rightPanel as React.ReactElement<any>, {
                isCollapsed: isRightCollapsed,
                onToggle: toggleRightPanel,
              })
            : rightPanel}
        </Panel>
      </Group>
    </div>
  );
};
