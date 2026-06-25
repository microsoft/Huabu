import React from 'react';
import ReactDOM from 'react-dom/client';

import './index.css';

import App from './App';
import { APP_NAME } from './config/app';

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
