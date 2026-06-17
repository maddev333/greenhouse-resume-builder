import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';
import App from './app';
import { hasMsalAuthResponseInUrl } from './auth/msal-config';

// Because `redirectUri` is this app's own origin, MSAL loads the SPA inside the sign-in popup, the
// hidden ssoSilent / silent-renewal iframe, and the top window when returning from a redirect. In
// every one of those cases the document URL carries the auth-server response (e.g. `#code=...&state=...`).
//
// When a response is present we must hand it to MSAL's redirect bridge instead of booting the app:
//   • popup / iframe — `broadcastResponseToMainFrame()` posts the payload to the main app frame over a
//     BroadcastChannel (which the parent's PopupClient / SilentIframeClient is waiting on) and closes
//     the child. Booting the app here instead leaves the child running a second MSAL client that never
//     broadcasts, so the parent hangs ("Checking auth…") or the popup is left blank on `#code=...`.
//   • redirect    — it caches the payload and navigates back to the app's origin URL, where the
//     freshly loaded app's `handleRedirectPromise()` completes sign-in.
//
// On any unexpected parse failure we fall through to render the app so the user is never stranded on a
// blank page.
function mountApp(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

if (hasMsalAuthResponseInUrl()) {
  void broadcastResponseToMainFrame().catch(() => mountApp());
} else {
  mountApp();
}
