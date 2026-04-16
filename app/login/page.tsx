'use client';

import { signIn } from 'next-auth/react';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function LoginContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await signIn('admin-login', { username, password, redirect: false });
    if (res?.ok) {
      window.location.href = '/';
    } else {
      setLoginError('Invalid username or password');
      setLoading(false);
    }
  }

  return (
    <div style={styles.page} suppressHydrationWarning>
      <div style={styles.card}>
        <div style={styles.logo}>🤖</div>
        <h1 style={styles.title}>Agents Chat</h1>
        <p style={styles.subtitle}>Sign in to continue</p>

        {(error || loginError) && (
          <div style={styles.error}>
            {loginError || (error === 'CredentialsSignin' ? 'Invalid username or password' : 'Sign in failed. Please try again.')}
          </div>
        )}

        {/* Microsoft login */}
        <button
          onClick={() => void signIn('azure-ad', { callbackUrl: '/' })}
          style={styles.msButton}
        >
          <svg width="20" height="20" viewBox="0 0 21 21" fill="none">
            <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
            <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
          </svg>
          <span>Sign in with Microsoft</span>
        </button>

        <div style={styles.divider}>
          <span style={styles.dividerLine} />
          <span style={styles.dividerText}>or</span>
          <span style={styles.dividerLine} />
        </div>

        {/* Admin login */}
        <form onSubmit={(e) => void handleAdminLogin(e)} style={styles.form}>
          <input
            type="text"
            placeholder="Admin username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={styles.input}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            autoComplete="current-password"
          />
          <button
            type="submit"
            disabled={loading || !username || !password}
            style={{
              ...styles.adminButton,
              opacity: loading || !username || !password ? 0.5 : 1,
            }}
          >
            {loading ? 'Signing in...' : 'Sign in as Admin'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #0d1117 0%, #161b22 50%, #1a1f2e 100%)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    background: 'rgba(22, 27, 34, 0.95)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '20px',
    padding: '48px 40px',
    width: '100%',
    maxWidth: '400px',
    textAlign: 'center' as const,
    boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
  },
  logo: {
    fontSize: '48px',
    marginBottom: '8px',
  },
  title: {
    margin: '0 0 4px',
    fontSize: '24px',
    fontWeight: 700,
    color: '#e6edf3',
    letterSpacing: '-0.02em',
  },
  subtitle: {
    margin: '0 0 28px',
    fontSize: '14px',
    color: '#8b949e',
  },
  error: {
    background: 'rgba(248, 81, 73, 0.1)',
    border: '1px solid rgba(248, 81, 73, 0.4)',
    borderRadius: '10px',
    padding: '10px 14px',
    marginBottom: '20px',
    color: '#f85149',
    fontSize: '13px',
  },
  msButton: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    padding: '12px 20px',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '12px',
    background: 'rgba(255,255,255,0.04)',
    color: '#e6edf3',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 150ms',
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    margin: '24px 0',
  },
  dividerLine: {
    flex: 1,
    height: '1px',
    background: 'rgba(255,255,255,0.08)',
  },
  dividerText: {
    fontSize: '12px',
    color: '#8b949e',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  input: {
    width: '100%',
    padding: '12px 16px',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '12px',
    background: 'rgba(255,255,255,0.04)',
    color: '#e6edf3',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  adminButton: {
    width: '100%',
    padding: '12px 20px',
    border: 'none',
    borderRadius: '12px',
    background: 'linear-gradient(135deg, #238636, #2ea043)',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 150ms',
  },
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
