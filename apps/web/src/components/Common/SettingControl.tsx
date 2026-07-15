import { cn } from './cn';

interface SettingControlProps {
  children: React.ReactNode;
  className?: string;
}

/** Standard width and shrink behavior for controls in Settings rows. */
export function SettingControl({ children, className }: SettingControlProps) {
  return <div className={cn('w-72 min-w-0', className)}>{children}</div>;
}
