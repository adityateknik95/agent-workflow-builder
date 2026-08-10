// One handler per step type, plus the branch evaluator.
//
// Each handler returns the output that gets stored on the step_run (and is
// therefore visible to the live subscription and referenceable by later steps),
// and optionally where the run should go next.
import { adminGraphql } from './gql';
import { fetchWithTimeout, HandlerError } from './http';
import { callLlm, LlmError } from './llm';
import { renderDeep, renderTemplate, resolvePath, tryParseJson, type TemplateData } from './template';
import { assertPrivilegedStepStillAuthorised } from './authz';
import type { NextInstruction, StepDefinition, StepOutcome } from './types';

interface StepEnvironment {
  runId: string;
  orgId: string;
  stepRunId: string;
  data: TemplateData;
}

// --- config readers ----------------------------------------------------------
function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' ? value : undefined;
}

function requireString(config: Record<string, unknown>, key: string, stepName: string): string {
  const value = readString(config, key);
  if (!value) {
    throw new HandlerError(`step "${stepName}" is missing required config "${key}"`, 'invalid-step-config');
  }
  return value;
}

function readNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Steps whose attempts are billed to the org quota. */
export function isBillable(stepType: string): boolean {
  return stepType === 'llm_call' || stepType === 'http_request';
}

/** Steps that are worth retrying by default. */
export function isRetryable(stepType: string): boolean {
  return stepType === 'llm_call' || stepType === 'http_request';
}

// --- llm_call ----------------------------------------------------------------
async function runLlmCall(step: StepDefinition, env: StepEnvironment): Promise<StepOutcome> {
  const prompt = renderTemplate(requireString(step.config, 'prompt', step.name), env.data);
  const system = readString(step.config, 'system');
  const wantsJson = step.config['response_format'] !== 'text';

  const result = await callLlm({
    prompt,
    system: system ? renderTemplate(system, env.data) : undefined,
    model: readString(step.config, 'model'),
    maxTokens: readNumber(step.config, 'max_tokens'),
    temperature: readNumber(step.config, 'temperature'),
    json: wantsJson,
  });

  return {
    output: {
      text: result.text,
      json: tryParseJson(result.text),
      provider: result.provider,
      model: result.model,
      stubbed: result.stubbed,
      usage: result.usage ?? null,
      prompt_preview: prompt.slice(0, 280),
    },
  };
}

// --- http_request ------------------------------------------------------------
async function runHttpRequest(step: StepDefinition, env: StepEnvironment): Promise<StepOutcome> {
  const url = renderTemplate(requireString(step.config, 'url', step.name), env.data);
  const method = (readString(step.config, 'method') ?? 'GET').toUpperCase();
  const headers = renderDeep(readRecord(step.config, 'headers'), env.data) as Record<string, string>;
  const timeoutMs = readNumber(step.config, 'timeout_ms') ?? 15_000;
  const expected = Array.isArray(step.config['expect_status'])
    ? (step.config['expect_status'] as unknown[]).filter((s): s is number => typeof s === 'number')
    : [];

  const init: RequestInit = { method, headers: { ...headers } };
  if (method !== 'GET' && method !== 'HEAD' && step.config['body'] !== undefined) {
    const body = renderDeep(step.config['body'], env.data);
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...headers };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (error) {
    // Network failure or timeout: worth another attempt.
    throw new HttpStepError(
      `${method} ${url} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      true
    );
  }

  const raw = await response.text();
  const parsed = tryParseJson(raw);

  const acceptable = expected.length > 0 ? expected.includes(response.status) : response.ok;
  if (!acceptable) {
    throw new HttpStepError(
      `${method} ${url} returned ${response.status}: ${raw.slice(0, 300)}`,
      response.status === 429 || response.status >= 500
    );
  }

  return {
    output: {
      status: response.status,
      ok: response.ok,
      url,
      method,
      body: parsed ?? raw.slice(0, 4000),
    },
  };
}

export class HttpStepError extends HandlerError {
  constructor(message: string, readonly retryable: boolean) {
    super(message, 'http-request-failed', 502);
    this.name = 'HttpStepError';
  }
}

// --- db_write ----------------------------------------------------------------
const INSERT_ARTIFACT = /* GraphQL */ `
  mutation InsertArtifact($object: workflow_artifacts_insert_input!) {
    insert_workflow_artifacts_one(object: $object) {
      id
      key
    }
  }
`;

async function runDbWrite(step: StepDefinition, env: StepEnvironment): Promise<StepOutcome> {
  // Second permission layer, checked again here rather than assumed from the
  // fact that the row exists.
  await assertPrivilegedStepStillAuthorised({
    orgId: env.orgId,
    stepType: 'db_write',
    stepName: step.name,
    authorId: step.created_by,
  });

  const key = renderTemplate(readString(step.config, 'key') ?? step.name, env.data);
  const payload = renderDeep(step.config['payload'] ?? {}, env.data);

  const data = await adminGraphql<{ insert_workflow_artifacts_one: { id: string; key: string } }>(
    INSERT_ARTIFACT,
    {
      object: {
        workflow_run_id: env.runId,
        step_run_id: env.stepRunId,
        key,
        payload,
      },
    }
  );

  return {
    output: {
      artifact_id: data.insert_workflow_artifacts_one.id,
      key: data.insert_workflow_artifacts_one.key,
      payload,
    },
  };
}

// --- notify ------------------------------------------------------------------
const INSERT_NOTIFICATION = /* GraphQL */ `
  mutation InsertNotification($object: notifications_insert_input!) {
    insert_notifications_one(object: $object) {
      id
      channel
      status
    }
  }
`;

async function runNotify(step: StepDefinition, env: StepEnvironment): Promise<StepOutcome> {
  await assertPrivilegedStepStillAuthorised({
    orgId: env.orgId,
    stepType: 'notify',
    stepName: step.name,
    authorId: step.created_by,
  });

  const channel = readString(step.config, 'channel') ?? 'slack';
  if (channel !== 'slack' && channel !== 'email') {
    throw new HandlerError(
      `step "${step.name}" has unsupported notify channel "${channel}"`,
      'invalid-step-config'
    );
  }

  // Enqueue only. Delivery is a Hasura Event Trigger on this table, so a slow
  // Slack endpoint cannot stall the run and gets its own retry budget.
  const data = await adminGraphql<{
    insert_notifications_one: { id: string; channel: string; status: string };
  }>(INSERT_NOTIFICATION, {
    object: {
      workflow_run_id: env.runId,
      step_run_id: env.stepRunId,
      channel,
      target: renderTemplate(readString(step.config, 'target') ?? '', env.data) || null,
      subject: renderTemplate(readString(step.config, 'subject') ?? '', env.data) || null,
      body: renderTemplate(readString(step.config, 'body') ?? '(no body)', env.data),
    },
  });

  return {
    output: {
      notification_id: data.insert_notifications_one.id,
      channel,
      delivery: 'queued for delivery by the notification Event Trigger',
    },
  };
}

// --- conditional_branch ------------------------------------------------------
function compare(observed: unknown, operator: string, expected: unknown, caseSensitive: boolean): boolean {
  const normalise = (value: unknown): unknown =>
    !caseSensitive && typeof value === 'string' ? value.toLowerCase() : value;

  const left = normalise(observed);
  const right = normalise(expected);

  switch (operator) {
    case 'equals':
      return String(left) === String(right);
    case 'not_equals':
      return String(left) !== String(right);
    case 'contains':
      return String(left ?? '').includes(String(right ?? ''));
    case 'not_contains':
      return !String(left ?? '').includes(String(right ?? ''));
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'regex':
      return new RegExp(String(expected), caseSensitive ? '' : 'i').test(String(observed ?? ''));
    case 'truthy':
      return Boolean(observed);
    case 'falsy':
      return !observed;
    default:
      throw new HandlerError(`unknown conditional operator "${operator}"`, 'invalid-step-config');
  }
}

function readBranch(config: Record<string, unknown>, key: string): NextInstruction {
  const branch = readRecord(config, key);
  if (branch['end'] === true) return { kind: 'end' };
  const target = readNumber(branch, 'goto');
  return target === undefined ? { kind: 'continue' } : { kind: 'goto', position: target };
}

function runConditionalBranch(step: StepDefinition, env: StepEnvironment): StepOutcome {
  const source = requireString(step.config, 'source', step.name);
  const operator = readString(step.config, 'operator') ?? 'truthy';
  const expected = step.config['value'];
  const caseSensitive = step.config['case_sensitive'] === true;

  const observed = resolvePath(env.data, source);
  const matched = compare(observed, operator, expected, caseSensitive);
  const next = matched ? readBranch(step.config, 'on_true') : readBranch(step.config, 'on_false');

  return {
    output: {
      source,
      observed: observed ?? null,
      operator,
      expected: expected ?? null,
      matched,
      branch_taken: matched ? 'on_true' : 'on_false',
      next: next.kind === 'goto' ? `step ${next.position}` : next.kind === 'end' ? 'end run' : 'next step',
    },
    next,
  };
}

// --- dispatch ----------------------------------------------------------------
export async function executeStep(step: StepDefinition, env: StepEnvironment): Promise<StepOutcome> {
  switch (step.type) {
    case 'llm_call':
      return runLlmCall(step, env);
    case 'http_request':
      return runHttpRequest(step, env);
    case 'db_write':
      return runDbWrite(step, env);
    case 'notify':
      return runNotify(step, env);
    case 'conditional_branch':
      return runConditionalBranch(step, env);
    case 'approval_gate':
      // Handled by the run loop, which pauses instead of executing anything.
      throw new HandlerError('approval_gate steps are not executed directly', 'internal-error', 500);
    default:
      throw new HandlerError(`unsupported step type "${step.type}"`, 'invalid-step-config');
  }
}

/** Whether a thrown step failure should be retried. */
export function shouldRetry(error: unknown): boolean {
  if (error instanceof LlmError || error instanceof HttpStepError) return error.retryable;
  // Configuration and authorisation failures will fail again identically.
  if (error instanceof HandlerError) return false;
  return true;
}
