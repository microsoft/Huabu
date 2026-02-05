import { Separator } from 'react-resizable-panels';

export const ResizableHandle = ({ className = '' }: { className?: string }) => {
  return (
    <Separator
      className={`flex w-2.5 cursor-col-resize items-center justify-center border-x border-gray-200 bg-gray-50 transition-colors hover:bg-gray-100 ${className}`}
    >
      <div className="h-5 w-1 rounded-sm bg-gray-300" />
    </Separator>
  );
};
