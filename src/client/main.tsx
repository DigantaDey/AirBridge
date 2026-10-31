import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';
import { installNativeShellBridge } from './engine/nativeShell.js';

// Inside the Android app this routes clipboard writes/reads and received-file
// saving through the shell; in a browser it does nothing.
installNativeShellBridge();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
