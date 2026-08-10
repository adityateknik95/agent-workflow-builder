// Hasura Event Trigger handler: a row landed in public.inbound_leads.
//
// This is the "database event" trigger type. Any workflow in the same org with an
// enabled `database_event` trigger watching this table starts a run, with no user
// and no button click. The run still goes through the same executor, so quota and
// step-level authorisation apply exactly as they do to a manual run.
import { loadWorkflowForTrigger, startRun } from '../_lib/executor';
import { adminGraphql } from '../_lib/gql';
import { assertFromHasura, respondWithError } from '../_lib/http';
import type { FnRequest, FnResponse } from '../_lib/types';

interface EventPayload {
  event: {
    op: 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL';
    data: { old: Record<string, unknown> | null; new: Record<string, unknown> | null };
  };
  table: { schema: string; name: string };
  trigger: { name: string };
}

const MATCHING_TRIGGERS = /* GraphQL */ `
  query DatabaseEventTriggers($org_id: uuid!, $table: String!) {
    workflow_triggers(
      where: {
        type: { _eq: "database_event" }
        is_enabled: { _eq: true }
        config: { _contains: { table: $table } }
        workflow: { org_id: { _eq: $org_id }, is_active: { _eq: true } }
      }
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

    const body = req.body as EventPayload;
    const row = body.event?.data?.new;
    const orgId = typeof row?.['org_id'] === 'string' ? (row['org_id'] as string) : null;

    if (!row || !orgId) {
      // Nothing actionable. Answer 200 so Hasura does not retry a payload that
      // will never become valid.
      res.status(200).json({ started: 0, reason: 'event carried no row with an org_id' });
      return;
    }

    const data = await adminGraphql<{ workflow_triggers: { workflow_id: string }[] }>(MATCHING_TRIGGERS, {
      org_id: orgId,
      table: body.table?.name ?? 'inbound_leads',
    });

    const started: { workflow_id: string; run_id: string; status: string }[] = [];
    const failed: { workflow_id: string; error: string }[] = [];

    for (const trigger of data.workflow_triggers) {
      const workflow = await loadWorkflowForTrigger(trigger.workflow_id);
      if (!workflow) continue;

      try {
        const result = await startRun({
          workflow,
          triggerType: 'database_event',
          triggeredBy: null,
          payload: { source: body.table?.name ?? 'inbound_leads', row },
        });
        started.push({ workflow_id: workflow.id, run_id: result.runId, status: result.status });
      } catch (error) {
        // A refusal such as an exhausted quota is a legitimate outcome for this
        // workflow and must not make Hasura retry the whole event.
        failed.push({
          workflow_id: workflow.id,
          error: error instanceof Error ? error.message : 'failed to start run',
        });
      }
    }

    res.status(200).json({ started: started.length, runs: started, refused: failed });
  } catch (error) {
    respondWithError(res, error);
  }
}
