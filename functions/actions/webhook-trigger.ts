// Hasura Action: startWorkflowFromWebhook(token, payload)
//
// The inbound endpoint external systems call. It is the one Action exposed to the
// unauthenticated `public` role, so there are no session variables to trust:
// authorisation is the trigger's own webhook token, which only an owner can read
// back out of the API (see the column-level permission on workflow_triggers), and
// which only an owner can create in the first place.
import { loadWorkflowForTrigger, startRun } from '../_lib/executor';
import { adminGraphql } from '../_lib/gql';
import { assertFromHasura, HandlerError, respondWithError } from '../_lib/http';
import type { ActionPayload, FnRequest, FnResponse } from '../_lib/types';

interface Input {
  token: string;
  payload?: Record<string, unknown> | null;
}

const FIND_TRIGGER = /* GraphQL */ `
  query FindWebhookTrigger($token: String!) {
    workflow_triggers(
      where: {
        webhook_token: { _eq: $token }
        type: { _eq: "webhook" }
        is_enabled: { _eq: true }
      }
      limit: 1
    ) {
      id
      workflow_id
      config
    }
  }
`;

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  try {
    assertFromHasura(req);

    const payload = req.body as ActionPayload<Input>;
    const token = payload.input?.token?.trim();
    if (!token) throw new HandlerError('token is required', 'bad-request');

    const data = await adminGraphql<{
      workflow_triggers: { id: string; workflow_id: string; config: Record<string, unknown> }[];
    }>(FIND_TRIGGER, { token });

    const trigger = data.workflow_triggers[0];
    if (!trigger) {
      // Nothing about which orgs or workflows exist is revealed by a bad token.
      throw new HandlerError('unknown or disabled webhook token', 'not-found', 404);
    }

    const workflow = await loadWorkflowForTrigger(trigger.workflow_id);
    if (!workflow) throw new HandlerError('the workflow for this token no longer exists', 'not-found', 404);

    const result = await startRun({
      workflow,
      triggerType: 'webhook',
      // Nobody pressed a button, so the run has no initiating user.
      triggeredBy: null,
      payload: payload.input?.payload ?? {},
    });

    res.status(200).json({
      workflow_run_id: result.runId,
      status: result.status,
      accepted: true,
      message: result.message,
    });
  } catch (error) {
    respondWithError(res, error);
  }
}
