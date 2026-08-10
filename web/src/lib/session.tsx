'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { StoredSession } from '@nhost/nhost-js/session';
import { nhost } from './nhost';
import { disposeSocket, request } from './graphql';

export type OrgRole = 'owner' | 'editor' | 'viewer';

export interface Membership {
  id: string;
  org_id: string;
  role: OrgRole;
  organization: { id: string; name: string; slug: string };
}

interface SessionValue {
  session: StoredSession | null;
  ready: boolean;
  memberships: Membership[];
  activeOrgId: string | null;
  activeOrg: Membership | null;
  /** The org role the app acts as for the selected organisation. */
  role: OrgRole | null;
  setActiveOrgId: (orgId: string) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMemberships: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

// Read with the bootstrap `user` role: it can see which orgs the caller belongs to
// and nothing else. Every later request uses the org role from this answer.
const MY_MEMBERSHIPS = /* GraphQL */ `
  query MyMemberships {
    org_members(order_by: { created_at: asc }) {
      id
      org_id
      role
      organization {
        id
        name
        slug
      }
    }
  }
`;

const ACTIVE_ORG_KEY = 'workflow-builder.active-org';

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const client = nhost();
    setSession(client.sessionStorage.get());
    setReady(true);
    return client.sessionStorage.onChange((next) => setSession(next ?? null));
  }, []);

  useEffect(() => {
    if (!session) {
      setMemberships([]);
      return;
    }
    let active = true;

    request<{ org_members: Membership[] }>(MY_MEMBERSHIPS, {}, 'user')
      .then((data) => {
        if (!active) return;
        setMemberships(data.org_members);

        const stored = window.localStorage.getItem(ACTIVE_ORG_KEY);
        const valid = data.org_members.some((m) => m.org_id === stored);
        setActiveOrgIdState(valid ? stored : (data.org_members[0]?.org_id ?? null));
      })
      .catch(() => {
        if (active) setMemberships([]);
      });

    return () => {
      active = false;
    };
  }, [session, nonce]);

  const setActiveOrgId = useCallback((orgId: string) => {
    window.localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    setActiveOrgIdState(orgId);
    // The role travels in the socket's connection payload, so switching org has to
    // rebuild it rather than reuse a socket opened for the previous role.
    disposeSocket();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await nhost().auth.signInEmailPassword({ email, password });
    if (!response.body.session) {
      throw new Error('sign-in did not return a session');
    }
  }, []);

  const signOut = useCallback(async () => {
    const refreshToken = nhost().sessionStorage.get()?.refreshToken;
    try {
      if (refreshToken) await nhost().auth.signOut({ refreshToken });
    } finally {
      nhost().sessionStorage.remove();
      disposeSocket();
      window.localStorage.removeItem(ACTIVE_ORG_KEY);
    }
  }, []);

  const activeOrg = useMemo(
    () => memberships.find((m) => m.org_id === activeOrgId) ?? null,
    [memberships, activeOrgId]
  );

  const value: SessionValue = {
    session,
    ready,
    memberships,
    activeOrgId,
    activeOrg,
    role: activeOrg?.role ?? null,
    setActiveOrgId,
    signIn,
    signOut,
    refreshMemberships: () => setNonce((n) => n + 1),
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export const canTriggerRuns = (role: OrgRole | null): boolean => role === 'owner' || role === 'editor';
export const canEditWorkflows = (role: OrgRole | null): boolean => role === 'owner' || role === 'editor';
export const canApprove = (role: OrgRole | null): boolean => role === 'owner' || role === 'editor';
