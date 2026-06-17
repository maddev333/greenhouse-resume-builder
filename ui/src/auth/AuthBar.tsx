/** Top auth bar — shows either a Sign-in button or logged-in user state. */

import { useAuth } from './useAuth';

export function AuthBar() {
  const { authenticated, loading, login } = useAuth();

  if (loading) {
    return (
      <span style={{ fontSize: '12px', color: '#9ca3af' }}>Checking auth…</span>
    );
  }

  if (authenticated) {
    return (
      <span style={{ fontSize: '12px', color: '#059669' }}>✓ Signed in</span>
    );
  }

  return (
    <button
      onClick={login}
      style={{ fontSize: '13px', padding: '6px 14px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}
    >
      Sign in with Microsoft
    </button>
  );
}
