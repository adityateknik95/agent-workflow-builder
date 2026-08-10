// The run loop: creates a run, walks its steps in order, retries what is worth
// retrying, pauses on approval gates, and charges the org's quota.
//
// Every trigger type funnels through here -- the Run button, the inbound webhook
// Action, the database Event Trigger and the cron dispatcher -- so there is one
// implementation of "what running a workflow means", and one place where quota
// and step-level authorisation are enforced.
import { adminGraphql } from './gql';
import { HandlerError, sleep } from './http';
import { executeStep, isBillable, isRetryable, shouldRetry } from './steps';
import { slugify, type TemplateData } from './template';
import { config } from './config';
import type {
  RunStatus,
  StepDefinition,
  StepRunRow,
  TriggerType,
} from './types';

/** Guard against a conditional_branch that jumps backwards forever. */
const MAX_HOPS = 60;

interface WorkflowRow {
  id: string;
  org_id: string;
  name: string;
  is_active: boolean;
  steps: StepDefinition[];
}

interface ExecutionContext {
  runId: string;
  orgId: string;
  workflowName: string;
  steps: StepDefinition[];
  stepRunsByStepId: Map<string, StepRunRow>;
  data: TemplateData;
  externalCalls: number;
  callsCharged: number;
  /** External calls this run may still make before hitting the org's quota. */
  budget: number;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  stepsExecuted: number;
  message: string;
}

// --- queries -----------------------------------------------------------------
const WORKFLOW_FOR_RUN = /* GraphQL */ `
  query WorkflowForRun($workflow_id: uuid!) {
    workflows_by_pk(id: $workflow_id) {
      id
      org_id
      name
      is_active
      steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
        created_by
      }
    }
  }
`;

const QUOTA_POSITION = /* GraphQL */ `
  query QuotaPosition($org_id: uuid!) {
    org_usage_summary(where: { org_id: { _eq: $org_id } }, limit: 1) {
      calls_used
      calls_allowed
      calls_remaining
    }
  }
`;

const CREATE_RUN = /* GraphQL */ `
  mutation CreateRun($run: workflow_runs_insert_input!) {
    insert_workflow_runs_one(object: $run) {
      id
      status
      org_id
      step_runs {
        id
        workflow_step_id
        position
        status
        output
        attempt
      }
    }
  }
`;

const LOAD_RUN = /* GraphQL */ `
  query LoadRun($run_id: uuid!) {
    workflow_runs_by_pk(id: $run_id) {
      id
      org_id
      status
      workflow_id
      trigger_payload
      resume_from_position
      external_calls
      calls_charged
      workflow {
        id
        org_id
        name
        is_active
        steps(order_by: { position: asc }) {
          id
          position
          type
          name
          config
          created_by
        }
      }
      step_runs(order_by: { position: asc }) {
        id
        workflow_step_id
        position
        status
        output
        attempt
      }
    }
  }
`;

const UPDATE_STEP_RUN = /* GraphQL */ `
  mutation UpdateStepRun($id: uuid!, $set: step_runs_set_input!) {
    update_step_runs_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      status
    }
  }
`;

const UPDATE_RUN = /* GraphQL */ `
  mutation UpdateRun($id: uuid!, $set: workflow_runs_set_input!) {
    update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      status
    }
  }
`;

const SKIP_PENDING_STEPS = /* GraphQL */ `
  mutation SkipPendingSteps($run_id: uuid!, $now: timestamptz!) {
    update_step_runs(
      where: { workflow_run_id: { _eq: $run_id }, status: { _eq: pending } }
      _set: { status: skipped, finished_at: $now }
    ) {
      affected_rows
    }
  }
`;

const CONSUME_QUOTA = /* GraphQL */ `
  mutation ConsumeQuota($org_id: uuid!, $amount: Int!, $run_id: uuid) {
    consume_org_quota(
      args: { p_org_id: $org_id, p_amount: $amount, p_run_id: $run_id, p_reason: "run_execution" }
    ) {
      granted
      calls_used_after
      calls_allowed
    }
  }
`;

// --- helpers -----------------------------------------------------------------
const nowIso = (): string => new Date().toISOString();

async function quotaRemaining(orgId: string): Promise<{ remaining: number; used: number; allowed: number }> {
  const data = await adminGraphql<{
    org_usage_summary: { calls_used: number; calls_allowed: number; calls_remaining: number }[];
  }>(QUOTA_POSITION, { org_id: orgId });

  const row = data.org_usage_summary[0];
  if (!row) throw new HandlerError('organisation has no usage record', 'not-found', 404);
  return { remaining: row.calls_remaining, used: row.calls_used, allowed: row.calls_allowed };
}

/** Rebuilds the template context from what the run has produced so far. */
function buildTemplateData(
  triggerPayload: unknown,
  steps: StepDefinition[],
  stepRunsByStepId: Map<string, StepRunRow>
): TemplateData {
  const stepData: Record<string, unknown> = {};

  for (const step of steps) {
    const stepRun = stepRunsByStepId.get(step.id);
    const entry = {
      name: step.name,
      type: step.type,
      position: step.position,
      status: stepRun?.status ?? 'pending',
      output: stepRun?.output ?? null,
    };
    stepData[String(step.position)] = entry;
    stepData[slugify(step.name)] = entry;
  }

  return { trigger: triggerPayload ?? {}, steps: stepData };
}

async function settleQuota(ctx: ExecutionContext): Promise<void> {
  const outstanding = ctx.externalCalls - ctx.callsCharged;
  if (outstanding <= 0) return;

  await adminGraphql(CONSUME_QUOTA, {
    org_id: ctx.orgId,
    amount: outstanding,
    run_id: ctx.runId,
  });
  ctx.callsCharged = ctx.externalCalls;
}

async function finishRun(
  ctx: ExecutionContext,
  status: RunStatus,
  stepsExecuted: number,
  error?: string
): Promise<RunResult> {
  await adminGraphql(SKIP_PENDING_STEPS, { run_id: ctx.runId, now: nowIso() });
  await settleQuota(ctx);
  await adminGraphql(UPDATE_RUN, {
    id: ctx.runId,
    set: {
      status,
      finished_at: nowIso(),
      error: error ?? null,
      external_calls: ctx.externalCalls,
      calls_charged: ctx.callsCharged,
      resume_from_position: null,
    },
  });

  return {
    runId: ctx.runId,
    status,
    stepsExecuted,
    message:
      status === 'succeeded'
        ? `Run finished: ${stepsExecuted} step(s) executed.`
        : (error ?? 'Run failed.'),
  };
}

async function pauseRun(
  ctx: ExecutionContext,
  step: StepDefinition,
  stepRun: StepRunRow,
  resumeFrom: number | null,
  stepsExecuted: number
): Promise<RunResult> {
  const instructions = typeof step.config['instructions'] === 'string' ? step.config['instructions'] : null;
  const allowedRoles = Array.isArray(step.config['allowed_roles'])
    ? step.config['allowed_roles']
    : ['owner', 'editor'];

  await adminGraphql(UPDATE_STEP_RUN, {
    id: stepRun.id,
    set: {
      status: 'paused',
      started_at: nowIso(),
      input: { instructions, allowed_roles: allowedRoles },
    },
  });

  // Charge for the work already done, so a run that sits paused for a week has
  // still been accounted for.
  await settleQuota(ctx);

  await adminGraphql(UPDATE_RUN, {
    id: ctx.runId,
    set: {
      status: 'paused',
      resume_from_position: resumeFrom,
      external_calls: ctx.externalCalls,
      calls_charged: ctx.callsCharged,
    },
  });

  return {
    runId: ctx.runId,
    status: 'paused',
    stepsExecuted,
    message: `Paused at step ${step.position} ("${step.name}") awaiting approval.`,
  };
}

// --- the loop ----------------------------------------------------------------
async function runLoop(ctx: ExecutionContext, startPosition: number): Promise<RunResult> {
  let index = ctx.steps.findIndex((step) => step.position >= startPosition);
  let stepsExecuted = 0;
  let hops = 0;

  while (index >= 0 && index < ctx.steps.length) {
    if (++hops > MAX_HOPS) {
      return finishRun(
        ctx,
        'failed',
        stepsExecuted,
        `Run stopped after ${MAX_HOPS} step transitions; a conditional_branch is probably looping.`
      );
    }

    const step = ctx.steps[index] as StepDefinition;
    const stepRun = ctx.stepRunsByStepId.get(step.id);
    if (!stepRun) {
      // A step added to the definition after this run started: nothing to record
      // progress on, so leave the run's shape as it was planned.
      index += 1;
      continue;
    }

    if (step.type === 'approval_gate') {
      if (stepRun.status === 'succeeded') {
        // Already cleared: this is a resumed run walking past its own gate.
        index += 1;
        continue;
      }
      if (stepRun.status === 'rejected') {
        return finishRun(ctx, 'failed', stepsExecuted, `Rejected at step ${step.position}.`);
      }
      const next = ctx.steps[index + 1];
      return pauseRun(ctx, step, stepRun, next ? next.position : null, stepsExecuted);
    }

    const maxAttempts =
      typeof step.config['max_attempts'] === 'number'
        ? Math.max(1, step.config['max_attempts'] as number)
        : isRetryable(step.type)
          ? config.defaultMaxAttempts
          : 1;

    let attempt = 0;
    let lastError: unknown;
    let succeeded = false;

    while (attempt < maxAttempts) {
      attempt += 1;

      if (isBillable(step.type) && ctx.externalCalls >= ctx.budget) {
        const message =
          `Quota exhausted: this run has already made ${ctx.externalCalls} external call(s), ` +
          `which is all the organisation has left for this period.`;
        await adminGraphql(UPDATE_STEP_RUN, {
          id: stepRun.id,
          set: { status: 'failed', attempt, error: message, finished_at: nowIso() },
        });
        return finishRun(ctx, 'failed', stepsExecuted, message);
      }

      await adminGraphql(UPDATE_STEP_RUN, {
        id: stepRun.id,
        set: {
          status: 'running',
          attempt,
          started_at: nowIso(),
          error: null,
          input: { config: step.config, attempt },
        },
      });

      if (isBillable(step.type)) {
        ctx.externalCalls += 1;
        await adminGraphql(UPDATE_RUN, {
          id: ctx.runId,
          set: { external_calls: ctx.externalCalls },
        });
      }

      try {
        const outcome = await executeStep(step, {
          runId: ctx.runId,
          orgId: ctx.orgId,
          stepRunId: stepRun.id,
          data: ctx.data,
        });

        await adminGraphql(UPDATE_STEP_RUN, {
          id: stepRun.id,
          set: { status: 'succeeded', output: outcome.output, finished_at: nowIso(), error: null },
        });

        stepRun.status = 'succeeded';
        stepRun.output = outcome.output;
        ctx.data = buildTemplateData(
          (ctx.data['trigger'] as Record<string, unknown>) ?? {},
          ctx.steps,
          ctx.stepRunsByStepId
        );
        stepsExecuted += 1;
        succeeded = true;

        const next = outcome.next ?? { kind: 'continue' as const };
        if (next.kind === 'end') {
          return finishRun(ctx, 'succeeded', stepsExecuted);
        }
        if (next.kind === 'goto') {
          const target = ctx.steps.findIndex((candidate) => candidate.position >= next.position);
          // A jump past the last step is the natural way to say "stop here".
          if (target === -1) return finishRun(ctx, 'succeeded', stepsExecuted);
          index = target;
        } else {
          index += 1;
        }
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const willRetry = attempt < maxAttempts && shouldRetry(error);

        await adminGraphql(UPDATE_STEP_RUN, {
          id: stepRun.id,
          set: {
            status: willRetry ? 'running' : 'failed',
            attempt,
            error: willRetry ? `attempt ${attempt} failed, retrying: ${message}` : message,
            ...(willRetry ? {} : { finished_at: nowIso() }),
          },
        });

        if (!willRetry) break;
        await sleep(500 * attempt);
      }
    }

    if (!succeeded) {
      const message = lastError instanceof Error ? lastError.message : 'step failed';
      return finishRun(ctx, 'failed', stepsExecuted, `Step ${step.position} ("${step.name}") failed: ${message}`);
    }
  }

  return finishRun(ctx, 'succeeded', stepsExecuted);
}

// --- entry points ------------------------------------------------------------
export interface StartRunParams {
  workflow: WorkflowRow;
  triggerType: TriggerType;
  /** Null for runs nobody pressed a button for: webhook, schedule, database event. */
  triggeredBy: string | null;
  payload: Record<string, unknown>;
}

/**
 * Loads a workflow by id for a caller who has already been authorised, or throws
 * a 404 that reveals nothing about whether the id exists.
 */
export async function loadWorkflowForTrigger(workflowId: string): Promise<WorkflowRow | null> {
  const data = await adminGraphql<{ workflows_by_pk: WorkflowRow | null }>(WORKFLOW_FOR_RUN, {
    workflow_id: workflowId,
  });
  return data.workflows_by_pk;
}

export async function startRun(params: StartRunParams): Promise<RunResult> {
  const { workflow, triggerType, triggeredBy, payload } = params;

  if (!workflow.is_active) {
    throw new HandlerError(`workflow "${workflow.name}" is not active`, 'workflow-inactive', 409);
  }
  if (workflow.steps.length === 0) {
    throw new HandlerError(`workflow "${workflow.name}" has no steps`, 'workflow-empty', 409);
  }

  // Quota is checked before anything is written, so an exhausted org gets a clear
  // refusal instead of a half-finished run.
  const quota = await quotaRemaining(workflow.org_id);
  if (quota.remaining <= 0) {
    throw new HandlerError(
      `Quota exhausted for this period: ${quota.used} of ${quota.allowed} calls used.`,
      'quota-exhausted',
      429
    );
  }

  // All step_runs are created up front as `pending`, so a client that subscribes
  // immediately sees the whole plan and watches rows light up.
  const created = await adminGraphql<{
    insert_workflow_runs_one: { id: string; org_id: string; step_runs: StepRunRow[] };
  }>(CREATE_RUN, {
    run: {
      workflow_id: workflow.id,
      trigger_type: triggerType,
      triggered_by: triggeredBy,
      trigger_payload: payload,
      status: 'running',
      started_at: nowIso(),
      step_runs: {
        data: workflow.steps.map((step) => ({
          workflow_step_id: step.id,
          position: step.position,
          step_type: step.type,
          step_name: step.name,
          status: 'pending',
        })),
      },
    },
  });

  const run = created.insert_workflow_runs_one;
  const stepRunsByStepId = new Map<string, StepRunRow>();
  for (const stepRun of run.step_runs) {
    if (stepRun.workflow_step_id) stepRunsByStepId.set(stepRun.workflow_step_id, stepRun);
  }

  const ctx: ExecutionContext = {
    runId: run.id,
    orgId: workflow.org_id,
    workflowName: workflow.name,
    steps: workflow.steps,
    stepRunsByStepId,
    data: buildTemplateData(payload, workflow.steps, stepRunsByStepId),
    externalCalls: 0,
    callsCharged: 0,
    budget: quota.remaining,
  };

  const firstStep = workflow.steps[0] as StepDefinition;
  return runLoop(ctx, firstStep.position);
}

/** Continues a paused run from `fromPosition`. Used by the approveStep Action. */
export async function resumeRun(runId: string, fromPosition: number | null): Promise<RunResult> {
  const data = await adminGraphql<{
    workflow_runs_by_pk: {
      id: string;
      org_id: string;
      status: RunStatus;
      trigger_payload: Record<string, unknown>;
      external_calls: number;
      calls_charged: number;
      workflow: WorkflowRow;
      step_runs: StepRunRow[];
    } | null;
  }>(LOAD_RUN, { run_id: runId });

  const run = data.workflow_runs_by_pk;
  if (!run) throw new HandlerError('run not found', 'not-found', 404);

  const stepRunsByStepId = new Map<string, StepRunRow>();
  for (const stepRun of run.step_runs) {
    if (stepRun.workflow_step_id) stepRunsByStepId.set(stepRun.workflow_step_id, stepRun);
  }

  const quota = await quotaRemaining(run.org_id);

  const ctx: ExecutionContext = {
    runId: run.id,
    orgId: run.org_id,
    workflowName: run.workflow.name,
    steps: run.workflow.steps,
    stepRunsByStepId,
    data: buildTemplateData(run.trigger_payload, run.workflow.steps, stepRunsByStepId),
    externalCalls: run.external_calls,
    callsCharged: run.calls_charged,
    // The budget covers what is left now, on top of what this run already spent.
    budget: run.external_calls + quota.remaining,
  };

  if (fromPosition === null) {
    return finishRun(ctx, 'succeeded', 0);
  }
  return runLoop(ctx, fromPosition);
}
