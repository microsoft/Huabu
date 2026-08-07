// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export * from './loader.interface.js';
export * from './pdf.loader.js';
export * from './office.loader.js';
export * from './web.loader.js';
export * from './text.loader.js';
export * from './youtube.loader.js';

import { OfficeLoader } from './office.loader.js';
import { PdfLoader } from './pdf.loader.js';
import { TextLoader } from './text.loader.js';
import { WebLoader } from './web.loader.js';
import { YoutubeLoader } from './youtube.loader.js';

import type { IDocumentLoader } from './loader.interface.js';

export class DocumentLoaderFactory {
  private static loaders: IDocumentLoader[] = [
    new PdfLoader(),
    new OfficeLoader(),
    new WebLoader(),
    new TextLoader(),
    new YoutubeLoader(),
  ];

  static getLoader(type: string): IDocumentLoader {
    const loader = this.loaders.find((l) => l.supports(type));
    if (!loader) {
      throw new Error(`No loader found for source type: ${type}`);
    }
    return loader;
  }

  static registerLoader(loader: IDocumentLoader) {
    this.loaders.push(loader);
  }
}
