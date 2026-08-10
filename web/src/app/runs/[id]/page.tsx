'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { StatusBadge } from '@/components/StatusBadge';
import { request, useQuery, useSubscription } from '@/lib/graphql';
import { canApprove, useSession } from '@/lib/session';
import { APPROVE_STEP, RUN_SIDE_EFFECTS, RUN_SUBSCRIPTION, STEP_RUNS_SUBSCRIPTION } from '@/lib/documents';

interface StepRun {
  id: string;
  position: number;
  step_name: string;
  step_type: string;
  status: string;
  attempt: number;
  error: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
  approved_at: string | null;
  approval_note: string | null;
  approver: { email: string; role: string } | null;
}

interface RunRow {
  id: string;
  status: string;
  trigger_type: string;
  error: string | null;
  external_calls: number;
  duration_seconds: number | null;
  created_at: string;
  finished_at: string | null;
  resume_from_position: number | null;
  workflow: { id: string; name: string };
  initiator: { email: string } | null;
}

function LiveRun() {
  const params = useParams<{ id: string }>();
  const runId = params.id;
  const { role } = useSession();

  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);

  // The required subscription: step_runs filtered to this workflow_run_id.
  const steps = useSubscription<{ step_runs: StepRun[] }>(
    STEP_RUNS_SUBSCRIPTION,
    { run_id: runId },
    { role: role ?? undefined, skip: !role }
  );

  const runInfo = useSubscription<{ workflow_runs_by_pk: RunRow | null }>(
    RUN_SUBSCRIPTION,
    { run_id: runId },
    { role: role ?? undefined, skip: !role }
  );

  const sideEffects = useQuery<{
    workflow_artifacts: { id: string; key: string; payload: unknown }[];
    notifications: { id: string; channel: string; target: string | null; status: string; error: string | null }[];
  }>(RUN_SIDE_EFFECTS, { run_id: runId }, { role: role ?? undefined, skip: !role });

  const run = runInfo.data?.workflow_runs_by_pk ?? null;
  const stepRuns = steps.data?.step_runs ?? [];
  const gate = stepRuns.find((step) => step.status === 'paused');

  async function decide(decision: 'approve' | 'reject') {
    if (!gate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ approveStep: { run_status: string; message: string } }>(
        APPROVE_STEP,
        { step_run_id: gate.id, decision, note: note.trim() || null },
        role ?? undefined
      );
      setDecisionMessage(result.approveStep.message);
      setNote('');
      sideEffects.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the decision could not be recorded');
    } finally {
      setBusy(false);
    }
  }

  // Nothing visible means the run is in another organisation, or does not exist.
  if (!run && stepRuns.length === 0) {
    return (
      <div className="card">
        <h2>Waiting for this run…</h2>
        <p className="muted small">
          If nothing appears, this run belongs to another organisation. The subscription stays open but the row
          filter never matches it, so no data is ever pushed — pasting someone else’s run id does not work.
        </p>
        <Link className="btn" href="/workflows">
          Back to workflows
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        {run && (
          <Link href={`/workflows/${run.workflow.id}`} className="small muted">
            ← {run.workflow.name}
          </Link>
        )}
      </div>

      <div className="row" style={{ marginBottom: '1rem' }}>
        <div>
          <h1>Run</h1>
          <span className="muted small mono">{runId}</span>
        </div>
        <div className="spacer" />
        {run && (
          <>
            <span className="badge">{run.trigger_type}</span>
            <StatusBadge status={run.status} />
          </>
        )}
      </div>

      {run && (
        <div className="card tight" style={{ marginBottom: '1rem' }}>
          <div className="row small muted">
            <span>started {new Date(run.created_at).toLocaleTimeString()}</span>
            <span>·</span>
            <span>{run.duration_seconds !== null ? `${run.duration_seconds}s` : 'running'}</span>
            <span>·</span>
            <span>{run.external_calls} external call(s) charged</span>
            <span>·</span>
            <span>{run.initiator ? run.initiator.email : 'started without a user'}</span>
          </div>
          {run.error && <div className="notice bad" style={{ marginTop: '0.6rem', marginBottom: 0 }}>{run.error}</div>}
        </div>
      )}

      {steps.error && <div className="notice bad">live connection: {steps.error}</div>}
      {error && <div className="notice bad">{error}</div>}
      {decisionMessage && <div className="notice ok">{decisionMessage}</div>}

      {gate && (
        <div className="notice paused">
          <strong>Paused — awaiting approval.</strong>{' '}
          {typeof gate.input?.['instructions'] === 'string'
            ? (gate.input['instructions'] as string)
            : 'This gate needs a decision before the run continues.'}
          {canApprove(role) ? (
            <div style={{ marginTop: '0.6rem' }}>
              <input
                placeholder="Note (optional)"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                style={{ marginBottom: '0.5rem' }}
              />
              <div className="row">
                <button className="primary" onClick={() => decide('approve')} disabled={busy}>
                  {busy ? 'Working…' : 'Approve and continue'}
                </button>
                <button className="danger" onClick={() => decide('reject')} disabled={busy}>
                  Reject
                </button>
              </div>
            </div>
          ) : (
            <div className="muted small" style={{ marginTop: '0.4rem' }}>
              Your role in this organisation cannot clear this gate.
            </div>
          )}
        </div>
      )}

      <h2>Steps</h2>
      {stepRuns.map((step) => (
        <div
          className={`step ${step.status === 'running' ? 'active' : ''} ${step.status === 'paused' ? 'gate' : ''}`}
          key={step.id}
        >
          <div className="step-index">{step.position}</div>
          <div className="step-body">
            <div className="row">
              <strong>{step.step_name}</strong>
              <span className="badge">{step.step_type}</span>
              <StatusBadge status={step.status} />
              {step.attempt > 1 && <span className="badge warn">attempt {step.attempt}</span>}
              <div className="spacer" />
              {step.started_at && step.finished_at && (
                <span className="muted small">
                  {Math.max(
                    0,
                    (new Date(step.finished_at).getTime() - new Date(step.started_at).getTime()) / 1000
                  ).toFixed(1)}
                  s
                </span>
              )}
            </div>

            {step.approver && (
              <div className="muted small" style={{ marginTop: '0.3rem' }}>
                decided by {step.approver.email} ({step.approver.role})
                {step.approval_note ? ` — “${step.approval_note}”` : ''}
              </div>
            )}

            {step.error && <div className="notice bad" style={{ margin: '0.45rem 0 0' }}>{step.error}</div>}

            {step.output && Object.keys(step.output).length > 0 && (
              <pre>{JSON.stringify(step.output, null, 2)}</pre>
            )}
          </div>
        </div>
      ))}

      {(sideEffects.data?.workflow_artifacts?.length ?? 0) > 0 && (
        <>
          <div className="divider" />
          <h2>Saved by db_write</h2>
          {sideEffects.data?.workflow_artifacts.map((artifact) => (
            <div className="card tight" key={artifact.id} style={{ marginBottom: '0.45rem' }}>
              <strong className="mono">{artifact.key}</strong>
              <pre>{JSON.stringify(artifact.payload, null, 2)}</pre>
            </div>
          ))}
        </>
      )}

      {(sideEffects.data?.notifications?.length ?? 0) > 0 && (
        <>
          <div className="divider" />
          <h2>Notifications</h2>
          {sideEffects.data?.notifications.map((notification) => (
            <div className="card tight" key={notification.id} style={{ marginBottom: '0.45rem' }}>
              <div className="row">
                <span className="badge">{notification.channel}</span>
                {notification.target && <span className="mono small">{notification.target}</span>}
                <StatusBadge status={notification.status} />
                <div className="spacer" />
                <button className="tiny" onClick={sideEffects.refetch}>
                  refresh
                </button>
              </div>
              {notification.error && (
                <div className="muted small" style={{ marginTop: '0.35rem' }}>
                  {notification.error}
                </div>
              )}
            </div>
          ))}
          <span className="muted small">
            Delivered by a Hasura Event Trigger, separately from the run, so a slow endpoint never stalls execution.
          </span>
        </>
      )}
    </>
  );
}

export default function RunPage() {
  return (
    <AppShell>
      <LiveRun />
    </AppShell>
  );
}
