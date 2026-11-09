import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { I18nProvider } from './app/i18n';
import './app/styles.css';
import { resolveDriver } from './driver-resolver';
import { replaceRepoDriver } from './core/persistence-store';

// Do not hardcode the per-chat preview hostname into tracked files. Launch the
// dev server with __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<hostname> when a proxy
// needs it.

(async () => {
  const driver = await resolveDriver();
  replaceRepoDriver(driver);
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
})();
