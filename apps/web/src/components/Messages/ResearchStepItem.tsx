import { Circle, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

import type { ResearchStep } from '@sediment/shared';

interface ResearchStepItemProps {
  step: ResearchStep;
  onViewNodes?: (nodeIds: string[]) => void;
}

export const ResearchStepItem = ({
  step,
  onViewNodes,
}: ResearchStepItemProps) => {
  const icon = {
    pending: <Circle className="h-3 w-3 text-gray-400" />,
    running: <Loader2 className="h-3 w-3 animate-spin text-blue-600" />,
    done: <CheckCircle2 className="h-3 w-3 text-green-600" />,
    error: <AlertCircle className="h-3 w-3 text-red-600" />,
  }[step.status];

  const handleViewNodes = () => {
    if (step.nodeIds && step.nodeIds.length > 0 && onViewNodes) {
      onViewNodes(step.nodeIds);
    }
  };

  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="mt-0.5">{icon}</div>

      <div className="min-w-0 flex-1">
        <div className="font-medium text-gray-900">{step.title}</div>
        {step.detail && (
          <div className="mt-0.5 text-gray-600">{step.detail}</div>
        )}
      </div>

      {/* Show jump button if there are associated nodes */}
      {step.nodeIds && step.nodeIds.length > 0 && (
        <button
          type="button"
          onClick={handleViewNodes}
          className="whitespace-nowrap text-blue-600 hover:underline"
        >
          View Nodes
        </button>
      )}
    </div>
  );
};
