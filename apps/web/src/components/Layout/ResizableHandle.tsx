import { Separator } from 'react-resizable-panels';

interface ResizableHandleProps {
  className?: string;
  disabled?: boolean;
}

export const ResizableHandle = ({
  className = '',
  disabled,
}: ResizableHandleProps) => {
  return (
    <Separator
      disabled={disabled}
      className={`group z-10 flex w-2 items-center justify-center bg-transparent transition-all outline-none ${disabled ? 'pointer-events-none w-0 opacity-0' : 'cursor-col-resize'} ${className}`}
    >
      <div className="group-hover:bg-primary h-8 w-1 rounded-full bg-gray-300 opacity-0 transition-all duration-300 group-hover:h-12 group-hover:opacity-100" />
    </Separator>
  );
};
