import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { applyTheme, boot, useStore } from './domain/store';

applyTheme(useStore.getState().ui.theme);
const root = createRoot(document.getElementById('root')!);
root.render(<div className="splash"><div><div className="spinner" /><b>Preparing demo data…</b><div className="muted" style={{ marginTop: 4 }}>Generating 26 days of trading history with the real engine</div></div></div>);
boot().then(() => root.render(<React.StrictMode><App /></React.StrictMode>)).catch((e) => {
  root.render(<div className="splash"><div><b>Failed to start</b><pre style={{ maxWidth: 600, whiteSpace: 'pre-wrap' }}>{String(e?.stack || e)}</pre></div></div>);
});
