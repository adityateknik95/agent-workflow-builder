'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { StatusBadge } from '@/components/StatusBadge';
import { AddStepForm, type StepTypeOption } from '@/components/StepEditor';
import { RunDialog } from '@/components/RunDialog';
import { request, useQuery } from '@/lib/graphql';
import { canEditWorkflows, canTriggerRuns, useSession } from '@/lib/session';
import {
  ADD_STEP,
  ADD_TRIGGER,
  DELETE_STEP,
  DELETE_TRIGGER,
  SET_TRIGGER_ENABLED,
  SWAP_STEP_POSITIONS,
  UPDATE_STEP,
  UPDATE_WORKFLOW,
  WEBHOOK_TOKEN,
  WORKFLOW_DETAIL,
} from '@/lib/documents';

interface Step {
  id: string;
  position: number;
  type: string;
  name: string;
  config: Record<string, unknown>;
  step_type: { requires_owner: boolean; comment: string };
}

interface Trigger {
  id: string;
  type: string;
  config: Record<string, unknown>;
  is_enabled: boolean;
  trigger_type: { requires_owner: boolean; comment: string };
}

interface Detail {
  workflows_by_pk: {
    id: string;
    org_id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    author: { email: string } | null;
    steps: Step[];
    triggers: Trigger[];
    runs: {
      id: string;
      status: string;
      trigger_type: string;
      created_at: string;
      duration_seconds: number | null;
      initiator: { email: string } | null;
    }[];
  } | null;
  step_types: StepTypeOption[];
  trigger_types: StepTypeOption[];
}

function Builder() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { role, activeOrgId } = useSession();
  const workflowId = params.id;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [draftConfig, setDraftConfig] = useState('');
  const [showRunDialog, setShowRunDialog] = useState(false);

  const { data, loading, error: queryError, refetch } = useQuery<Detail>(
    WORKFLOW_DETAIL,
    { id: workflowId },
    { role: role ?? undefined, skip: !role }
  );

  const tokenQuery = useQuery<{ workflow_triggers: { id: string; webhook_token: string | null }[] }>(
    WEBHOOK_TOKEN,
    { workflow_id: workflowId },
    { role: role ?? undefined, skip: role !== 'owner' }
  );

  const workflow = data?.workflows_by_pk;
  const editable = canEditWorkflows(role);
  const isOwner = role === 'owner';

  async function run<T>(operation: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the operation failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="card">loading workflow…</div>;

  if (queryError) {
    return (
      <div className="card">
        <h2>Could not load this workflow</h2>
        <div className="notice bad">{queryError}</div>
        <div className="row">
          <button className="primary" onClick={refetch}>
            Try again
          </button>
          <Link className="btn" href="/workflows">
            Back to workflows
          </Link>
        </div>
      </div>
    );
  }

  // A workflow in another organisation resolves to null here, exactly as if the id
  // did not exist -- the row permission never matches it.
  if (!workflow) {
    return (
      <div className="card">
        <h2>Not available</h2>
        <p className="muted small">
          No workflow with this id exists in <strong>{activeOrgId ? 'the selected organisation' : 'your orgs'}</strong>.
          If it belongs to another organisation, it is invisible here by design -- switching the id in the URL does
          not get you in.
        </p>
        <Link className="btn" href="/workflows">
          Back to workflows
        </Link>
      </div>
    );
  }

  const steps = workflow.steps;
  const webhookToken = tokenQuery.data?.workflow_triggers?.[0]?.webhook_token;
  const availableTriggerTypes = (data?.trigger_types ?? []).filter(
    (option) => !workflow.triggers.some((trigger) => trigger.type === option.value)
  );

  async function moveStep(index: number, direction: -1 | 1) {
    const a = steps[index];
    const b = steps[index + direction];
    if (!a || !b) return;
    // One mutation, one transaction: the deferred unique constraint on
    // (workflow_id, position) lets the two rows swap without a temporary hole.
    await run(() =>
      request(
        SWAP_STEP_POSITIONS,
        { a_id: a.id, a_position: b.position, b_id: b.id, b_position: a.position },
        role ?? undefined
      )
    );
  }

  return (
    <>
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <Link href="/workflows" className="small muted">
          ← workflows
        </Link>
      </div>

      <div className="row" style={{ marginBottom: '1rem' }}>
        <div style={{ minWidth: 0 }}>
          <h1>{workflow.name}</h1>
          <span className="muted small">
            {workflow.description ?? 'No description.'}
            {workflow.author ? ` · created by ${workflow.author.email}` : ''}
          </span>
        </div>
        <div className="spacer" />

        {editable && (
          <button
            className="tiny"
            disabled={busy}
            onClick={() =>
              run(() =>
                request(
                  UPDATE_WORKFLOW,
                  { id: workflow.id, set: { is_active: !workflow.is_active } },
                  role ?? undefined
                )
              )
            }
          >
            {workflow.is_active ? 'Deactivate' : 'Activate'}
          </button>
        )}

        {/* The Run button is not rendered for viewers. The Action's permission and
            the handler's own role check are what actually stop them. */}
        {canTriggerRuns(role) && (
          <button className="primary" onClick={() => setShowRunDialog(true)} disabled={busy || steps.length === 0}>
            Run workflow
          </button>
        )}
      </div>

      {error && <div className="notice bad">{error}</div>}
      {role === 'viewer' && (
        <div className="notice">
          You are a viewer in this organisation: runs and edits are unavailable, but you can open any run and watch
          it live.
        </div>
      )}

      <div className="grid two">
        <div>
          <h2>Steps</h2>
          {steps.length === 0 && <div className="card tight muted small">No steps yet.</div>}

          {steps.map((step, index) => (
            <div className={`step ${step.type === 'approval_gate' ? 'gate' : ''}`} key={step.id}>
              <div className="step-index">{step.position}</div>
              <div className="step-body">
                <div className="row">
                  <strong>{step.name}</strong>
                  <span className="badge">{step.type}</span>
                  {step.step_type.requires_owner && <span className="badge warn">owner only</span>}
                  <div className="spacer" />
                  {editable && (
                    <>
                      <button className="tiny" disabled={busy || index === 0} onClick={() => moveStep(index, -1)}>
                        ↑
                      </button>
                      <button
                        className="tiny"
                        disabled={busy || index === steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        className="tiny"
                        onClick={() => {
                          setEditingStep(editingStep === step.id ? null : step.id);
                          setDraftConfig(JSON.stringify(step.config, null, 2));
                        }}
                      >
                        {editingStep === step.id ? 'close' : 'edit'}
                      </button>
                      <button
                        className="tiny danger"
                        disabled={busy}
                        onClick={() => run(() => request(DELETE_STEP, { id: step.id }, role ?? undefined))}
                      >
                        delete
                      </button>
                    </>
                  )}
                </div>

                {editingStep === step.id ? (
                  <div style={{ marginTop: '0.5rem' }}>
                    <textarea value={draftConfig} onChange={(event) => setDraftConfig(event.target.value)} />
                    <div className="row" style={{ marginTop: '0.4rem' }}>
                      <button
                        className="primary tiny"
                        disabled={busy}
                        onClick={async () => {
                          let parsed: unknown;
                          try {
                            parsed = JSON.parse(draftConfig);
                          } catch {
                            setError('the config is not valid JSON');
                            return;
                          }
                          await run(() =>
                            request(UPDATE_STEP, { id: step.id, set: { config: parsed } }, role ?? undefined)
                          );
                          setEditingStep(null);
                        }}
                      >
                        Save config
                      </button>
                    </div>
                  </div>
                ) : (
                  <pre>{JSON.stringify(step.config, null, 2)}</pre>
                )}
              </div>
            </div>
          ))}

          {editable && (
            <div style={{ marginTop: '1rem' }}>
              <AddStepForm
                stepTypes={data?.step_types ?? []}
                isOwner={isOwner}
                busy={busy}
                onAdd={async (type, name, config) => {
                  const nextPosition = steps.reduce((max, step) => Math.max(max, step.position), 0) + 1;
                  await request(
                    ADD_STEP,
                    { workflow_id: workflow.id, position: nextPosition, type, name, config },
                    role ?? undefined
                  );
                  refetch();
                }}
              />
            </div>
          )}
        </div>

        <div>
          <h2>Triggers</h2>
          {workflow.triggers.length === 0 && <div className="card tight muted small">No triggers attached.</div>}

          {workflow.triggers.map((trigger) => (
            <div className="card tight" key={trigger.id} style={{ marginBottom: '0.55rem' }}>
              <div className="row">
                <strong>{trigger.type}</strong>
                {trigger.trigger_type.requires_owner && <span className="badge warn">owner only</span>}
                <span className={`badge ${trigger.is_enabled ? 'ok' : ''}`}>
                  {trigger.is_enabled ? 'enabled' : 'disabled'}
                </span>
                <div className="spacer" />
                {editable && (
                  <>
                    <button
                      className="tiny"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          request(
                            SET_TRIGGER_ENABLED,
                            { id: trigger.id, is_enabled: !trigger.is_enabled },
                            role ?? undefined
                          )
                        )
                      }
                    >
                      {trigger.is_enabled ? 'disable' : 'enable'}
                    </button>
                    <button
                      className="tiny danger"
                      disabled={busy}
                      onClick={() => run(() => request(DELETE_TRIGGER, { id: trigger.id }, role ?? undefined))}
                    >
                      delete
                    </button>
                  </>
                )}
              </div>
              <p className="muted small" style={{ margin: '0.35rem 0 0' }}>
                {trigger.trigger_type.comment}
              </p>
              {Object.keys(trigger.config).length > 0 && <pre>{JSON.stringify(trigger.config, null, 2)}</pre>}

              {trigger.type === 'webhook' && (
                <div style={{ marginTop: '0.5rem' }}>
                  {isOwner ? (
                    <>
                      <label>Webhook token</label>
                      <pre style={{ marginTop: 0 }}>{webhookToken ?? 'loading…'}</pre>
                      <span className="muted small">
                        Anyone holding this can start a run. Only owners can read it — the column is absent from the
                        editor and viewer permissions.
                      </span>
                    </>
                  ) : (
                    <span className="muted small">The token is only readable by an owner.</span>
                  )}
                </div>
              )}
            </div>
          ))}

          {editable && availableTriggerTypes.length > 0 && (
            <div className="card tight">
              <h3>Attach a trigger</h3>
              <div className="row">
                {availableTriggerTypes.map((option) => {
                  const blocked = option.requires_owner && !isOwner;
                  return (
                    <button
                      key={option.value}
                      className="tiny"
                      disabled={busy || blocked}
                      title={blocked ? 'owner only' : option.comment}
                      onClick={() =>
                        run(() =>
                          request(
                            ADD_TRIGGER,
                            {
                              workflow_id: workflow.id,
                              type: option.value,
                              config:
                                option.value === 'schedule'
                                  ? { cron: '*/10 * * * *' }
                                  : option.value === 'database_event'
                                    ? { table: 'inbound_leads' }
                                    : {},
                            },
                            role ?? undefined
                          )
                        )
                      }
                    >
                      + {option.value}
                      {blocked ? ' (owner only)' : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="divider" />

          <h2>Recent runs</h2>
          {workflow.runs.length === 0 && <div className="card tight muted small">No runs yet.</div>}
          <ul className="list-reset">
            {workflow.runs.map((runRow) => (
              <li className="card tight" key={runRow.id} style={{ marginBottom: '0.45rem' }}>
                <div className="row">
                  <StatusBadge status={runRow.status} />
                  <span className="badge">{runRow.trigger_type}</span>
                  <div className="spacer" />
                  <Link href={`/runs/${runRow.id}`} className="small">
                    open
                  </Link>
                </div>
                <div className="muted small" style={{ marginTop: '0.3rem' }}>
                  {new Date(runRow.created_at).toLocaleString()}
                  {runRow.duration_seconds !== null ? ` · ${runRow.duration_seconds}s` : ''}
                  {runRow.initiator ? ` · ${runRow.initiator.email}` : ' · no user'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {showRunDialog && (
        <RunDialog
          workflowId={workflow.id}
          orgId={workflow.org_id}
          role={role}
          onClose={() => setShowRunDialog(false)}
          onStarted={(runId) => router.push(`/runs/${runId}`)}
        />
      )}
    </>
  );
}

export default function WorkflowPage() {
  return (
    <AppShell>
      <Builder />
    </AppShell>
  );
}
