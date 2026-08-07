// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Folder } from 'lucide-react';
import { useCallback, useState } from 'react';

import { pickFolder } from '@/api/workspace';
import { useFolderPickerSupported } from '@/store/workspaceStore';

import { Button } from './Button';
import { cn } from './cn';
import { Loading } from './Loading';
import { TextInput } from './TextInput';
import { toast } from './Toast';

import type { KeyboardEventHandler } from 'react';

export interface PathInputProps {
  id?: string;
  /** Current path value. */
  value: string;
  /** Called with the new value on typing *and* after a folder is picked. */
  onChange: (value: string) => void;
  /**
   * Optional hook fired after a folder is successfully picked (the value
   * has already been pushed through `onChange`). Use it to auto-submit,
   * e.g. activate the chosen workspace.
   */
  onPicked?: (path: string) => void;
  /**
   * How to surface the "no picker on this server" case and thrown errors.
   * Defaults to a toast. Pass a callback to render the message inline
   * instead (used by full-page flows where no toast host is mounted).
   */
  onError?: (message: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Controls button size, icon size and default input padding. */
  size?: 'sm' | 'md';
  /** Use a monospace font for the input (paths read better). */
  mono?: boolean;
  /** Tooltip on the folder-picker button. */
  pickTitle?: string;
  /** Whether this field may use the local native picker. Defaults to true. */
  pickerEnabled?: boolean;
  /** Extra classes merged onto the input. Later classes win (tailwind-merge). */
  inputClassName?: string;
  /** Extra classes merged onto the flex row wrapper. */
  className?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}

/**
 * A path text field with an optional native folder-picker button.
 *
 * The folder button only renders when the server reports a GUI is
 * available (`capabilities.nativePicker`); on headless/remote servers it
 * degrades to a plain input that still accepts a typed absolute path.
 * The `pickFolder` call, its loading state and error reporting are
 * handled internally so call sites stay declarative.
 */
export function PathInput({
  id,
  value,
  onChange,
  onPicked,
  onError,
  ariaLabel,
  placeholder,
  disabled,
  size = 'md',
  mono = false,
  pickTitle = 'Browse for a folder',
  pickerEnabled = true,
  inputClassName,
  className,
  onKeyDown,
}: PathInputProps) {
  const folderPickerSupported = useFolderPickerSupported();
  const [picking, setPicking] = useState(false);

  const reportError = useCallback(
    (message: string) => {
      if (onError) onError(message);
      else toast(message, { tone: 'danger' });
    },
    [onError],
  );

  const handlePick = useCallback(async () => {
    setPicking(true);
    try {
      const result = await pickFolder();
      if (result.ok) {
        onChange(result.path);
        onPicked?.(result.path);
      } else if (result.reason === 'no-picker') {
        reportError('No folder picker available on this server');
      }
    } catch (err) {
      reportError(
        err instanceof Error ? err.message : 'Failed to open folder picker',
      );
    } finally {
      setPicking(false);
    }
  }, [onChange, onPicked, reportError]);

  const iconSize = size === 'sm' ? 14 : 16;

  return (
    <div className={cn('flex items-stretch gap-1.5', className)}>
      <TextInput
        id={id}
        type="text"
        size={size}
        mono={mono}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        wrapperClassName="min-w-0 flex-1"
        className={cn(
          'text-fg-default focus:border-edge-strong w-full focus:ring-0',
          size === 'sm' && 'py-1',
          inputClassName,
        )}
      />
      {pickerEnabled && folderPickerSupported && (
        <Button
          variant="outline"
          tone="neutral"
          size={size}
          iconOnly
          title={pickTitle}
          onClick={() => void handlePick()}
          disabled={disabled || picking}
          className="aspect-square"
        >
          {picking ? (
            <Loading layout="inline" size="sm" className="text-fg-subtle" />
          ) : (
            <Folder size={iconSize} className="text-fg-subtle" />
          )}
        </Button>
      )}
    </div>
  );
}
