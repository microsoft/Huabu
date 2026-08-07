// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React from 'react';
import ReactDOM from 'react-dom/client';

import './index.css';
import './i18n';

import App from './App';
import { APP_NAME } from './config/app';

document.title = APP_NAME;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

// `html`/`body`/`#root` are `overflow: hidden`, which stops the user from
// scrolling but not the browser: a `scrollIntoView` or a focus deep in the
// tree still scrolls these ancestors, and without a scrollbar the shifted
// UI can never be scrolled back. Pin them.
for (const el of [document.documentElement, document.body, rootElement]) {
  el.addEventListener(
    'scroll',
    () => {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    },
    { passive: true },
  );
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
