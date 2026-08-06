// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';

const PHRASES = ['Thinking'];

const CYCLE_MS = 10000;

/**
 * Animated loading indicator that cycles through phrases with a
 * shimmer gradient effect, replacing the old three-dot ellipsis.
 */
export const ThinkingIndicator = () => {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % PHRASES.length);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="thinking-shimmer inline-block text-sm font-normal">
      {PHRASES[index]}…
    </span>
  );
};
