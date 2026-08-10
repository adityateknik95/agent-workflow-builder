'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

/** The seeded accounts, listed so a reviewer can switch personas quickly. */
const DEMO_ACCOUNTS = [
  { email: 'owner.a@example.com', label: 'owner · Northwind Labs' },
  { email: 'editor.a@example.com', label: 'editor · Northwind Labs' },
  { email: 'viewer.a@example.com', label: 'viewer · Northwind Labs' },
  { email: 'owner.b@example.com', label: 'owner · Contoso Support' },
  { email: 'editor.b@example.com', label: 'editor · Contoso Support' },
];

export default function LoginPage() {
  const router = useRouter();
  const { session, ready, signIn } = useSession();
  const [email, setEmail] = useState('owner.a@example.com');
  const [password, setPassword] = useState('Password123!');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready && session) router.replace('/workflows');
  }, [ready, session, router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      router.push('/workflows');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="login-card">
        <div className="card">
          <h1>Agent Workflow Builder</h1>
          <p className="muted small">
            Sign in with nhost Auth. The role you get is per organisation, and it is decided by your membership
            row -- not by anything the browser sends.
          </p>

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            {error && <div className="notice bad">{error}</div>}

            <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        {/* Collapsed by default. The roster is here so a reviewer can switch
            between roles and organisations without going back to the README, but
            it has no business being the first thing on a sign-in screen. */}
        <details className="disclosure">
          <summary>Reviewing this? Demo accounts</summary>
          <div className="disclosure-body">
            <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
              Every account uses the password <span className="mono">Password123!</span>. Roles are per
              organisation, so the same person can be an owner in one org and nothing in another.
            </p>
            {DEMO_ACCOUNTS.map((account) => (
              <div className="demo-account" key={account.email}>
                <span>
                  <span className="mono">{account.email}</span>
                  <br />
                  <span className="muted small">{account.label}</span>
                </span>
                <button type="button" className="tiny" onClick={() => setEmail(account.email)}>
                  use
                </button>
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}
