import React from 'react';
import ReactDOM from 'react-dom/client';

import { setupWebLayoutSolvers } from '@sediment/shared/canvas-engine/web';

import './index.css';

import App from './App';
import { APP_NAME } from './config/app';

// Register the cytoscape-based auto-layout solvers. Must run before any
// canvas command executes — `cytoscape-layout-utilities` reads `window`
// at module-load, so this import only happens on the web host. The
// server / headless executor never imports this subpath and falls back
// to the no-op layout engine in `@sediment/shared/canvas-engine`.
setupWebLayoutSolvers();

document.title = APP_NAME;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
