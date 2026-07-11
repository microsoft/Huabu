import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { routerBasename } from './basePath';
import { DocsApp } from './DocsApp';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Docs root element was not found.');
}

hydrateRoot(
  rootElement,
  <StrictMode>
    <BrowserRouter basename={routerBasename}>
      <DocsApp />
    </BrowserRouter>
  </StrictMode>,
);
