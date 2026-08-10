'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { QuotaIndicator } from './QuotaIndicator';

/**
 * Wraps every signed-in page: sends anonymous visitors to the login screen, and
 * puts the organisation switcher, the caller's role in that org, and the quota
 * indicator in the header.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { session, ready, memberships, activeOrg, activeOrgId, setActiveOrgId, role, signOut } = useSession();

  if (!ready) {
    return (
      <div className="center-page">
        <span className="muted">loading…</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="center-page">
        <div className="card login-card">
          <h2>Sign in required</h2>
          <p className="muted small">This page needs a signed-in member of an organisation.</p>
          <Link className="btn" href="/login">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/workflows" className="brand">
          Agent Workflow Builder
        </Link>

        {memberships.length > 0 && (
          <select
            aria-label="Organisation"
            value={activeOrgId ?? ''}
            onChange={(event) => setActiveOrgId(event.target.value)}
            style={{ width: 'auto', minWidth: 180 }}
          >
            {memberships.map((membership) => (
              <option key={membership.org_id} value={membership.org_id}>
                {membership.organization.name}
              </option>
            ))}
          </select>
        )}

        {role && <span className="badge role">{role}</span>}

        <div className="spacer" />

        {activeOrgId && <QuotaIndicator orgId={activeOrgId} role={role} />}

        <span className="muted small">{session.user?.email}</span>
        <button
          className="tiny"
          onClick={async () => {
            await signOut();
            router.push('/login');
          }}
        >
          Sign out
        </button>
      </header>

      <div className="container">
        {memberships.length === 0 ? (
          <div className="card">
            <h2>No organisation yet</h2>
            <p className="muted small">
              This account is not a member of any organisation. Organisations are provisioned out of band --
              run <span className="mono">npm run seed</span> to create the two demo orgs, or ask an owner to add
              you.
            </p>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
