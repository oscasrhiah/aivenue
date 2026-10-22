import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

if (window.__AIVENUE__?.host === 'vscode') document.documentElement.dataset.host = 'vscode';
// Files dropped outside the composer must not make the window navigate to them.
for (const ev of ['dragover', 'drop'] as const) window.addEventListener(ev, (e) => e.preventDefault());
createRoot(document.getElementById('root')!).render(<App />);
