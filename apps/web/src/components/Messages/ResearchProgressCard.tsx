import { Sparkles, Layout, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { ResearchStepItem } from './ResearchStepItem';
import { IconButton } from '../Common/IconButton';

import type { ResearchStep } from '@sediment/shared';

interface ResearchProgressCardProps {
  query: string;
  steps: ResearchStep[];
  status: 'running' | 'completed' | 'error';
  nodeIds?: string[];
  onCancel?: () => void;
  onViewCanvas?: () => void;
  onViewNodes?: (nodeIds: string[]) => void;
}

export const ResearchProgressCard = ({
  query,
  steps,
  status,
  nodeIds = [],
  onCancel,
  onViewCanvas,
  onViewNodes,
}: ResearchProgressCardProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const progress =
    steps.length > 0
      ? steps.filter((s) => s.status === 'done').length / steps.length
      : 0;

  const isRunning = status === 'running';
  const isCompleted = status === 'completed';
  const isError = status === 'error';

  // Choose color based on status
  const colorClasses = isError
    ? 'border-red-200 bg-red-50'
    : isCompleted
    ? 'border-green-200 bg-green-50'
    : 'border-blue-200 bg-blue-50';

  const textColorClasses = isError
    ? 'text-red-900'
    : isCompleted
    ? 'text-green-900'
    : 'text-blue-900';

  const subtextColorClasses = isError
    ? 'text-red-700'
    : isCompleted
    ? 'text-green-700'
    : 'text-blue-700';

  const progressBarColorClasses = isError
    ? 'bg-red-600'
    : isCompleted
    ? 'bg-green-600'
    : 'bg-blue-600';

  const progressBarBgColorClasses = isError
    ? 'bg-red-200'
    : isCompleted
    ? 'bg-green-200'
    : 'bg-blue-200';

  return (
    <div className={`rounded-2xl border p-4 ${colorClasses}`}>
      {/* Header: question + progress */}
      <div className="mb-3 flex items-start justify-between">
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles
              className={`h-4 w-4 ${
                isError
                  ? 'text-red-600'
                  : isCompleted
                  ? 'text-green-600'
                  : 'text-blue-600'
              }`}
            />
            <span className={`text-sm font-semibold ${textColorClasses}`}>
              {isError
                ? 'Research Error'
                : isCompleted
                ? 'Research Completed'
                : 'Deep Research in Progress'}
            </span>
          </div>
          <div className={`line-clamp-2 text-xs ${subtextColorClasses}`}>
            {query}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          {onViewCanvas && (
            <IconButton
              size="sm"
              variant="outline"
              onClick={onViewCanvas}
              title="View in Canvas"
            >
              <Layout className="h-3 w-3" />
            </IconButton>
          )}
          {isRunning && onCancel && (
            <IconButton
              size="sm"
              variant="outline"
              onClick={onCancel}
              title="Cancel Research"
            >
              <X className="h-3 w-3" />
            </IconButton>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isRunning && (
        <div
          className={`mb-3 h-1.5 w-full overflow-hidden rounded-full ${progressBarBgColorClasses}`}
        >
          <div
            className={`h-full transition-all duration-300 ${progressBarColorClasses}`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}

      {/* Step list (collapsible) */}
      {steps.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className={`flex items-center gap-1 text-xs hover:underline ${
              isError
                ? 'text-red-600'
                : isCompleted
                ? 'text-green-600'
                : 'text-blue-600'
            }`}
          >
            {isExpanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {isExpanded ? 'Hide Details' : 'Show Details'}
          </button>

          {isExpanded && (
            <div className="mt-2 space-y-2">
              {steps.map((step) => (
                <ResearchStepItem
                  key={step.id}
                  step={step}
                  onViewNodes={onViewNodes}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Completion summary */}
      {isCompleted && (
        <div className="mt-3 rounded-lg border border-green-300 bg-green-100 p-3 text-xs text-green-800">
          <div className="mb-1 font-medium">
            Research results added to Canvas
          </div>
          <div className="flex flex-wrap gap-2">
            <span>• {nodeIds.length} nodes</span>
            <span>• {steps.length} steps completed</span>
          </div>
        </div>
      )}
    </div>
  );
};
