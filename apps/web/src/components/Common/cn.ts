// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
