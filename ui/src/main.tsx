import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import { processAuthResponseInUrl } from './auth/useAuth';

// Because the auth `redirectUri` is this app's own origin, the SPA is loaded inside the sign-in popup,
// the hidden silent-renewal iframe, and the top window when returning from a redirect. In every one of
// those cases the document URL carries the auth-server response (e.g. `?code=...&state=...`).
//
// `processAuthResponseInUrl()` hands that response to the active provider's callback machinery (MSAL's
// redirect bridge, or oidc-client-ts's popup/silent/redirect callbacks) instead of booting a second
// app — which would race the parent over the shared token-request cache. It resolves to `true` when it
// handled a response (the window will close or navigate, so we must NOT mount), and `false` when
// there's nothing to handle or the app should mount. On any failure we mount so the user is never
// stranded on a blank page.
function mountApp(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void processAuthResponseInUrl()
  .then((handled) => {
    if (!handled) mountApp();
  })
  .catch(() => mountApp());
