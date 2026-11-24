import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import './app/commands';
import './app/pageCommands';
import './app/featureCommands';
import './app/advancedCommands';
import './app/formCommands';
import './app/markCommands';
import App from './App';
import { runCommand } from './app/commands';
import { bridge } from './lib/api';

// Test automation hook: only when the main process runs the E2E harness
// (never in packaged builds, see electron/ipc/handlers.ts `E2E_DIR`).
bridge()
  .app.info()
  .then((i) => {
    if (i.e2e && !i.isPackaged) (window as unknown as { __pdfed: unknown }).__pdfed = { runCommand };
  })
  .catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
