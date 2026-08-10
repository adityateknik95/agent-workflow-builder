'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { StatusBadge } from '@/components/StatusBadge';
import { useQuery, request } from '@/lib/graphql';
import { canEditWorkflows, useSession } from '@/lib/session';
import { CREATE_WORKFLOW, ORG_WORKFLOWS } from '@/lib/documents';

interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  steps_aggregate: { aggregate: { count: number } | null };
  triggers: { id: string; type: string; is_enabled: boolean }[];
  runs: { id: string; status: string; trigger_type: string; created_at: string; duration_seconds: number | null }[];
}

function WorkflowList() {
  const router = useRouter();
  const { activeOrgId, activeOrg, role } = useSession();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading, error: queryError, refetch } = useQuery<{ workflows: WorkflowSummary[] }>(
    ORG_WORKFLOWS,
    { org_id: activeOrgId },
    { role: role ?? undefined, skip: !activeOrgId || !role }
  );

  async function createWorkflow(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !activeOrgId) return;
    setCreating(true);
    setError(null);
    try {
      const result = await request<{ insert_workflows_one: { id: string } }>(
        CREATE_WORKFLOW,
        { org_id: activeOrgId, name: name.trim(), description: null },
        role ?? undefined
      );
      setName('');
      router.push(`/workflows/${result.insert_workflows_one.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not create the workflow');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <div>
          <h1>{activeOrg?.organization.name ?? 'Workflows'}</h1>
          <span className="muted small">
            {role === 'viewer'
              ? 'Read-only access: you can follow runs but not start or edit them.'
              : 'Build a workflow, attach a trigger, and watch runs step by step.'}
          </span>
        </div>
      </div>

      {canEditWorkflows(role) && (
        <form className="card tight" onSubmit={createWorkflow} style={{ marginBottom: '1rem' }}>
          <div className="row">
            <input
              placeholder="New workflow name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <button className="primary" type="submit" disabled={creating || !name.trim()}>
              {creating ? 'Creating…' : 'Create workflow'}
            </button>
          </div>
          {error && <div className="notice bad" style={{ marginTop: '0.6rem', marginBottom: 0 }}>{error}</div>}
        </form>
      )}

      {loading && <div className="card">loading workflows…</div>}

      {queryError && (
        <div className="notice bad">
          could not load workflows: {queryError}
          <div style={{ marginTop: '0.5rem' }}>
            <button className="tiny" onClick={refetch}>
              Try again
            </button>
          </div>
        </div>
      )}

      {!loading && !queryError && (data?.workflows?.length ?? 0) === 0 && (
        <div className="card">
          <h2>Nothing here yet</h2>
          <p className="muted small">
            No workflows in this organisation. {canEditWorkflows(role) ? 'Create one above.' : ''}
          </p>
        </div>
      )}

      <div className="grid">
        {data?.workflows?.map((workflow) => {
          const lastRun = workflow.runs[0];
          return (
            <div className="card" key={workflow.id}>
              <div className="row">
                <Link href={`/workflows/${workflow.id}`} style={{ fontWeight: 600 }}>
                  {workflow.name}
                </Link>
                {!workflow.is_active && <span className="badge warn">inactive</span>}
                <div className="spacer" />
                {lastRun ? (
                  <Link href={`/runs/${lastRun.id}`} className="row" style={{ gap: '0.4rem' }}>
                    <span className="muted small">last run</span>
                    <StatusBadge status={lastRun.status} />
                  </Link>
                ) : (
                  <span className="muted small">never run</span>
                )}
              </div>

              {workflow.description && (
                <p className="muted small" style={{ marginTop: '0.4rem' }}>
                  {workflow.description}
                </p>
              )}

              <div className="row small muted" style={{ marginTop: '0.5rem' }}>
                <span>{workflow.steps_aggregate.aggregate?.count ?? 0} steps</span>
                <span>·</span>
                {workflow.triggers.length === 0 ? (
                  <span>no triggers</span>
                ) : (
                  workflow.triggers.map((trigger) => (
                    <span key={trigger.id} className={`badge ${trigger.is_enabled ? '' : 'warn'}`}>
                      {trigger.type}
                      {trigger.is_enabled ? '' : ' (off)'}
                    </span>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="divider" />
      <button className="tiny" onClick={refetch}>
        Refresh
      </button>
    </>
  );
}

export default function WorkflowsPage() {
  return (
    <AppShell>
      <WorkflowList />
    </AppShell>
  );
}
