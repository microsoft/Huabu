import React from 'react';
import ReactDOM from 'react-dom/client';

import type { SendMessageRequest } from "@sediment/shared";

// Example usage of shared type
const request: SendMessageRequest = {
  content: "Hello from Web"
};
console.log(request);

function App() {
  return (
    <div>
      <h1>Sediment Web</h1>
      <p>Shared type check: {request.content}</p>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
