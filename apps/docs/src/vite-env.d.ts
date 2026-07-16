// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/// <reference types="vite/client" />

declare module '@pagefind/default-ui' {
  export class PagefindUI {
    constructor(options: {
      element: string | HTMLElement;
      bundlePath?: string;
      baseUrl?: string;
      showSubResults?: boolean;
      pageSize?: number;
    });
  }
}
