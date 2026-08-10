// Hasura Action: triggerWorkflowRun(workflow_id, input)
//
// The Action's own permission list already keeps `viewer` from seeing this
// mutation at all. That is not enough on its own: a role permission proves which
// role the caller asked Hasura for, not that they hold it in the organisation
// that owns this particular workflow. So the workflow is loaded first, and the
// caller's membership of *that* workflow's org is checked before a run exists.
import { requireRoleInOrg } from '../_lib/authz';
import { loadWorkflowForTrigger, startRun } from '../_lib/executor';
import { assertFromHasura, HandlerError, respondWithError } from '../_lib/http';
import type { ActionPayload, FnRequest, FnResponse } from '../_lib/types';

interface Input {
  workflow_id: string;
  input?: Record<string, unknown> | null;
}

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  try {
    assertFromHasura(req);

    const payload = req.body as ActionPayload<Input>;
    const workflowId = payload.input?.workflow_id;
    if (!workflowId) throw new HandlerError('workflow_id is required', 'bad-request');

    const userId = payload.session_variables?.['x-hasura-user-id'];

    const workflow = await loadWorkflowForTrigger(workflowId);

    // A caller from another org and a caller naming an id that does not exist get
    // the same answer, so guessing ids leaks nothing -- not even existence.
    const notFound = 'no workflow with that id is available to you';
    if (!workflow) throw new HandlerError(notFound, 'not-found', 404);

    await requireRoleInOrg(workflow.org_id, userId, ['owner', 'editor'], notFound);

    const result = await startRun({
      workflow,
      triggerType: 'manual',
      triggeredBy: userId ?? null,
      payload: payload.input?.input ?? {},
    });

    res.status(200).json({
      workflow_run_id: result.runId,
      status: result.status,
      steps_executed: result.stepsExecuted,
      message: result.message,
    });
  } catch (error) {
    respondWithError(res, error);
  }
}
