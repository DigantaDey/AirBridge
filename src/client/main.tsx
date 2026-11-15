import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';
import { installNativeShellBridge, isNativeShell } from './engine/nativeShell.js';

// Inside the Android app this routes clipboard writes/reads and received-file
// saving through the shell; in a browser it does nothing.
installNativeShellBridge();

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  if (isNativeShell() || (typeof window !== 'undefined' && window.location.hostname === '127.0.0.1' && 'AirBridgeAndroid' in window)) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {});
    if (typeof caches !== 'undefined') {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch(() => {});
    }
  } else {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
