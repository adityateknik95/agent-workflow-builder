'use client';

import { useState } from 'react';

export interface StepTypeOption {
  value: string;
  comment: string;
  requires_owner: boolean;
}

/** Sensible starting config per step type, so a new step is runnable immediately. */
const TEMPLATES: Record<string, unknown> = {
  llm_call: {
    system: 'Reply with JSON only.',
    prompt: 'Classify this message: {{trigger.row.message}}',
    max_tokens: 300,
    temperature: 0.1,
  },
  http_request: {
    method: 'POST',
    url: 'https://jsonplaceholder.typicode.com/posts',
    headers: { 'content-type': 'application/json' },
    body: { title: '{{trigger.row.company}}' },
    expect_status: [200, 201],
    timeout_ms: 15000,
  },
  db_write: {
    key: 'result',
    payload: { summary: '{{steps.1.output.json.summary}}' },
  },
  notify: {
    channel: 'slack',
    target: '#general',
    subject: 'Workflow finished',
    body: '{{steps.1.output.text}}',
  },
  conditional_branch: {
    source: 'steps.1.output.json.urgency',
    operator: 'equals',
    value: 'high',
    on_true: { goto: 3 },
    on_false: { goto: 5 },
  },
  approval_gate: {
    instructions: 'Check this before the run continues.',
    allowed_roles: ['owner', 'editor'],
  },
};

export function newStepConfig(type: string): string {
  return JSON.stringify(TEMPLATES[type] ?? {}, null, 2);
}

interface Props {
  stepTypes: StepTypeOption[];
  isOwner: boolean;
  busy: boolean;
  onAdd: (type: string, name: string, config: Record<string, unknown>) => Promise<void>;
}

export function AddStepForm({ stepTypes, isOwner, busy, onAdd }: Props) {
  const [type, setType] = useState('llm_call');
  const [name, setName] = useState('');
  const [config, setConfig] = useState(() => newStepConfig('llm_call'));
  const [error, setError] = useState<string | null>(null);

  const selected = stepTypes.find((option) => option.value === type);
  const blockedForRole = Boolean(selected?.requires_owner) && !isOwner;

  function changeType(next: string) {
    setType(next);
    setConfig(newStepConfig(next));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config) as Record<string, unknown>;
    } catch {
      setError('the config is not valid JSON');
      return;
    }

    try {
      await onAdd(type, name.trim() || type.replace(/_/g, ' '), parsed);
      setName('');
      setConfig(newStepConfig(type));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not add the step');
    }
  }

  return (
    <form className="card tight" onSubmit={submit}>
      <h3>Add a step</h3>

      <div className="grid two">
        <div className="field">
          <label htmlFor="step-type">Type</label>
          <select id="step-type" value={type} onChange={(event) => changeType(event.target.value)}>
            {stepTypes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value}
                {option.requires_owner ? ' — owner only' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="step-name">Name</label>
          <input
            id="step-name"
            placeholder={type.replace(/_/g, ' ')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </div>

      {selected && <p className="muted small">{selected.comment}</p>}

      {blockedForRole && (
        <div className="notice">
          <strong>{type}</strong> reaches outside the sandbox, so only an owner can add it. The insert is refused
          by the database permission as well, not just hidden here.
        </div>
      )}

      <div className="field">
        <label htmlFor="step-config">Config (JSON)</label>
        <textarea id="step-config" value={config} onChange={(event) => setConfig(event.target.value)} />
        <span className="muted small">
          Reference earlier work with <span className="mono">{'{{trigger.row.email}}'}</span> or{' '}
          <span className="mono">{'{{steps.1.output.json.urgency}}'}</span>.
        </span>
      </div>

      {error && <div className="notice bad">{error}</div>}

      <button className="primary" type="submit" disabled={busy || blockedForRole}>
        {busy ? 'Saving…' : 'Add step'}
      </button>
    </form>
  );
}
