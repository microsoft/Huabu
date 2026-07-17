// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Small data table component for reference-style pages.
 *
 * Designed for short, two- or three-column lookup tables (shortcuts,
 * settings, comparisons). Long-form prose still belongs in `P`.
 */

import { cn } from './cn';

import type { ReactNode } from 'react';

export function Table({
  headers,
  rows,
  className,
}: {
  headers: string[];
  rows: ReactNode[][];
  className?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-gray-200',
        className,
      )}
    >
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr className="bg-gray-50 text-left text-[12px] font-semibold tracking-wide text-gray-600 uppercase">
            {headers.map((header) => (
              <th key={header} className="px-4 py-2.5">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white text-gray-700">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-2.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
