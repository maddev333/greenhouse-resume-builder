/** Top auth bar — shows either a Sign-in button or logged-in user state. */

import { useAuth } from './useAuth';
import { authProvider } from './provider';

const SIGN_IN_LABEL = authProvider === 'keycloak' ? 'Sign in with Keycloak' : 'Sign in with Microsoft';

export function AuthBar() {
  const { authenticated, loading, login, logout, user, error } = useAuth();

  if (loading) {
    return (
      <span style={{ fontSize: '12px', color: '#9ca3af' }}>Checking auth…</span>
    );
  }

  if (authenticated) {
    return (
      <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: '12px', color: '#059669' }}>✓ Signed in{user?.username ? ` as ${user.username}` : ''}</span>
        <button
          onClick={() => void logout()}
          style={{ fontSize: '12px', padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' }}
        >
          Sign out
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {error ? <span style={{ fontSize: '12px', color: '#dc2626' }}>{error}</span> : null}
      <button
        onClick={() => void login()}
        style={{ fontSize: '13px', padding: '6px 14px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}
      >
        {SIGN_IN_LABEL}
      </button>
    </span>
  );
}
