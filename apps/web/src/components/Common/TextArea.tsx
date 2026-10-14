// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { textInputClassName } from './TextInput';

import type { TextInputProps } from './TextInput';
import type { Ref, TextareaHTMLAttributes } from 'react';

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  Pick<TextInputProps, 'size' | 'mono'> & {
    ref?: Ref<HTMLTextAreaElement>;
  };

export function TextArea({
  className,
  mono,
  size,
  ref,
  ...props
}: TextAreaProps) {
  return (
    <textarea
      ref={ref}
      className={textInputClassName({ className, mono, size })}
      {...props}
    />
  );
}
