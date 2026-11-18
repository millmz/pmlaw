import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyPrefs } from './prefs.js';
import './styles.css';

// Theme and text size are stamped before the first paint — no flash.
applyPrefs();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
