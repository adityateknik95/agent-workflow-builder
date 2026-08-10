'use client';

import { useState } from 'react';
import { request } from '@/lib/graphql';
import { ADD_LEAD, TRIGGER_RUN } from '@/lib/documents';
import type { OrgRole } from '@/lib/session';

interface Props {
  workflowId: string;
  orgId: string;
  role: OrgRole | null;
  onClose: () => void;
  onStarted: (runId: string) => void;
}

/**
 * Collects the payload for a run and offers the two ways to start one from inside
 * the app: the triggerWorkflowRun Action, or writing a row into the watched table
 * and letting the database Event Trigger start it.
 */
export function RunDialog({ workflowId, orgId, role, onClose, onStarted }: Props) {
  const [email, setEmail] = useState('ops@acme.test');
  const [company, setCompany] = useState('Acme Industrial');
  const [message, setMessage] = useState(
    'Our production integration is down since this morning. This is urgent.'
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function startNow() {
    setBusy(true);
    setError(null);
    try {
      const result = await request<{
        triggerWorkflowRun: { workflow_run_id: string; status: string; message: string };
      }>(TRIGGER_RUN, { workflow_id: workflowId, input: { row: { email, company, message } } }, role ?? undefined);
      onStarted(result.triggerWorkflowRun.workflow_run_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not start the run');
    } finally {
      setBusy(false);
    }
  }

  async function insertLead() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await request(ADD_LEAD, { org_id: orgId, email, company, message }, role ?? undefined);
      setInfo(
        'Lead saved. Hasura’s Event Trigger is starting a run for every workflow watching that table — it will ' +
          'appear under recent runs in a moment, with no button pressed.'
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save the lead');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 12, 0.66)',
        display: 'grid',
        placeItems: 'center',
        padding: '1.5rem',
        zIndex: 50,
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 520 }} onClick={(event) => event.stopPropagation()}>
        <h2>Start a run</h2>
        <p className="muted small">
          This payload becomes the run’s trigger input, which the steps read as{' '}
          <span className="mono">{'{{trigger.row.*}}'}</span>. Mention something urgent to send the branch down the
          approval path.
        </p>

        <div className="field">
          <label htmlFor="run-email">Email</label>
          <input id="run-email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="run-company">Company</label>
          <input id="run-company" value={company} onChange={(event) => setCompany(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="run-message">Message</label>
          <textarea
            id="run-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            style={{ minHeight: 90 }}
          />
        </div>

        {error && <div className="notice bad">{error}</div>}
        {info && <div className="notice ok">{info}</div>}

        <div className="row">
          <button className="primary" onClick={startNow} disabled={busy}>
            {busy ? 'Running…' : 'Run now'}
          </button>
          <button onClick={insertLead} disabled={busy} title="Insert a row into inbound_leads">
            Save as inbound lead
          </button>
          <div className="spacer" />
          <button onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
