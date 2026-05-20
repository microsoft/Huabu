import React from 'react';
import ReactDOM from 'react-dom/client';

import '@blocknote/core/fonts/inter.css';
import '@blocknote/shadcn/style.css';
import './index.css';

import App from './App';
import { APP_NAME } from './config/app';

document.title = APP_NAME;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

const root = ReactDOM.createRoot(rootElement);

// Dev-only Milkdown validation harness (Phase 1a). Activated via
// `?milkdown-validate=1`. Lazy-imported so the Milkdown bundle is
// excluded from the regular production load.
if (
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('milkdown-validate') === '1'
) {
  void import('./components/Milkdown/_validate/MilkdownValidatePage').then(
    ({ default: MilkdownValidatePage }) => {
      root.render(
        <React.StrictMode>
          <MilkdownValidatePage />
        </React.StrictMode>,
      );
    },
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
