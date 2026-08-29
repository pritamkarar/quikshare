import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerDownloadWorker } from './save/swstream.js';
import './styles/app.css';

/*
 * Registered on every load, not only when a session starts.
 *
 * client/save/select.ts registers this same worker as part of resolving the
 * save tier, which happens when a session starts (client/hooks/useSession.ts).
 * That is too late for one launch in particular: an installed app opened
 * straight from the OS share sheet POSTs its files at the app before any
 * session exists, and a POST no worker intercepts reaches the server with its
 * body already spent. The files cannot be recovered from there — hence
 * server/index.ts's apologetic redirect for that case.
 *
 * The name says "download" because that is what the worker was built for; it
 * is one worker at /sw.js serving both jobs.
 *
 * Failure is swallowed *here* and nowhere else: on a browser without the tier
 * this rejects on every load, and the save tier registers again when a
 * session starts — reporting the failure there, which is the screen where it
 * means something a user can act on.
 */
void registerDownloadWorker().catch(() => {});

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
