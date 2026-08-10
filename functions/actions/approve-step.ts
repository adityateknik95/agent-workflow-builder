// Hasura Action: approveStep(step_run_id, decision, note)
//
// This is the case that cannot be a database permission. Clearing an approval
// gate is a decision taken in the middle of an execution: it has to check the
// approver's role, record who decided, flip the gate, and then resume the run
// from the next step. A row-level rule can express none of that, so the check
// lives here -- and there is deliberately no update permission on step_runs for
// any client role, which means this handler is the only way through the gate.
import { requireRoleInOrg } from '../_lib/authz';
import { resumeRun } from '../_lib/executor';
import { adminGraphql } from '../_lib/gql';
import { assertFromHasura, HandlerError, respondWithError } from '../_lib/http';
import type { ActionPayload, FnRequest, FnResponse, OrgRole } from '../_lib/types';

interface Input {
  step_run_id: string;
  decision: 'approve' | 'reject';
  note?: string | null;
}

const LOAD_GATE = /* GraphQL */ `
  query LoadGate($step_run_id: uuid!) {
    step_runs_by_pk(id: $step_run_id) {
      id
      org_id
      status
      step_type
      step_name
      position
      workflow_run_id
      step {
        config
      }
      run {
        id
        status
        resume_from_position
      }
    }
  }
`;

// Guarded by `status: paused` so two approvers racing on the same gate cannot both
// win: the second update matches no rows.
const CLAIM_GATE = /* GraphQL */ `
  mutation ClaimGate($id: uuid!, $set: step_runs_set_input!) {
    update_step_runs(where: { id: { _eq: $id }, status: { _eq: paused } }, _set: $set) {
      affected_rows
    }
  }
`;

const CLAIM_RUN = /* GraphQL */ `
  mutation ClaimRun($id: uuid!) {
    update_workflow_runs(
      where: { id: { _eq: $id }, status: { _eq: paused } }
      _set: { status: running }
    ) {
      affected_rows
    }
  }
`;

const FAIL_RUN = /* GraphQL */ `
  mutation FailRun($id: uuid!, $error: String!, $now: timestamptz!) {
    update_workflow_runs_by_pk(
      pk_columns: { id: $id }
      _set: { status: failed, error: $error, finished_at: $now, resume_from_position: null }
    ) {
      id
    }
  }
`;

const SKIP_REMAINING = /* GraphQL */ `
  mutation SkipRemaining($run_id: uuid!, $now: timestamptz!) {
    update_step_runs(
      where: { workflow_run_id: { _eq: $run_id }, status: { _eq: pending } }
      _set: { status: skipped, finished_at: $now }
    ) {
      affected_rows
    }
  }
`;

function allowedRolesFor(config: unknown): OrgRole[] {
  const raw = (config as Record<string, unknown> | null)?.['allowed_roles'];
  if (!Array.isArray(raw)) return ['owner', 'editor'];
  const roles = raw.filter((role): role is OrgRole => role === 'owner' || role === 'editor' || role === 'viewer');
  return roles.length > 0 ? roles : ['owner', 'editor'];
}

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  try {
    assertFromHasura(req);

    const payload = req.body as ActionPayload<Input>;
    const stepRunId = payload.input?.step_run_id;
    const decision = payload.input?.decision;
    if (!stepRunId) throw new HandlerError('step_run_id is required', 'bad-request');
    if (decision !== 'approve' && decision !== 'reject') {
      throw new HandlerError('decision must be approve or reject', 'bad-request');
    }

    const userId = payload.session_variables?.['x-hasura-user-id'];
    const notFound = 'no approval step with that id is available to you';

    const data = await adminGraphql<{
      step_runs_by_pk: {
        id: string;
        org_id: string;
        status: string;
        step_type: string;
        step_name: string;
        position: number;
        workflow_run_id: string;
        step: { config: unknown } | null;
        run: { id: string; status: string; resume_from_position: number | null };
      } | null;
    }>(LOAD_GATE, { step_run_id: stepRunId });

    const gate = data.step_runs_by_pk;
    if (!gate) throw new HandlerError(notFound, 'not-found', 404);

    // Same answer for "belongs to another org" as for "does not exist".
    const approverRole = await requireRoleInOrg(
      gate.org_id,
      userId,
      allowedRolesFor(gate.step?.config),
      notFound
    );

    if (gate.step_type !== 'approval_gate') {
      throw new HandlerError(`step "${gate.step_name}" is not an approval gate`, 'not-an-approval-gate', 409);
    }
    if (gate.status !== 'paused') {
      throw new HandlerError(
        `this gate is already ${gate.status}; it cannot be decided again`,
        'gate-already-decided',
        409
      );
    }

    const now = new Date().toISOString();
    const claimed = await adminGraphql<{ update_step_runs: { affected_rows: number } }>(CLAIM_GATE, {
      id: gate.id,
      set: {
        status: decision === 'approve' ? 'succeeded' : 'rejected',
        approved_by: userId,
        approved_at: now,
        approval_note: payload.input?.note ?? null,
        finished_at: now,
        output: {
          decision,
          decided_by_role: approverRole,
          note: payload.input?.note ?? null,
        },
      },
    });

    if (claimed.update_step_runs.affected_rows === 0) {
      throw new HandlerError('this gate was decided by someone else a moment ago', 'gate-already-decided', 409);
    }

    if (decision === 'reject') {
      await adminGraphql(SKIP_REMAINING, { run_id: gate.workflow_run_id, now });
      await adminGraphql(FAIL_RUN, {
        id: gate.workflow_run_id,
        error: `Rejected at step ${gate.position} ("${gate.step_name}") by an ${approverRole}.`,
        now,
      });

      res.status(200).json({
        step_run_id: gate.id,
        run_status: 'failed',
        resumed: false,
        message: `Rejected step ${gate.position}; the run has been stopped.`,
      });
      return;
    }

    // Move the run out of `paused` before executing, again guarded on the current
    // status so a double approval cannot start the tail of the run twice.
    const claimedRun = await adminGraphql<{ update_workflow_runs: { affected_rows: number } }>(CLAIM_RUN, {
      id: gate.workflow_run_id,
    });
    if (claimedRun.update_workflow_runs.affected_rows === 0) {
      throw new HandlerError('this run is no longer paused', 'run-not-paused', 409);
    }

    const result = await resumeRun(gate.workflow_run_id, gate.run.resume_from_position);

    res.status(200).json({
      step_run_id: gate.id,
      run_status: result.status,
      resumed: true,
      message: result.message,
    });
  } catch (error) {
    respondWithError(res, error);
  }
}
