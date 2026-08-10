// Hasura Cron Trigger handler, called once a minute.
//
// Each workflow's cron expression lives on its `schedule` trigger row, so members
// can add and change schedules through the app without anyone editing Hasura
// metadata. This function is the single scheduled entry point that evaluates them.
import { cronMatches } from '../_lib/cron';
import { loadWorkflowForTrigger, startRun } from '../_lib/executor';
import { adminGraphql } from '../_lib/gql';
import { assertFromHasura, respondWithError } from '../_lib/http';
import type { FnRequest, FnResponse } from '../_lib/types';

const SCHEDULE_TRIGGERS = /* GraphQL */ `
  query ScheduleTriggers($since: timestamptz!) {
    workflow_triggers(
      where: {
        type: { _eq: "schedule" }
        is_enabled: { _eq: true }
        workflow: { is_active: { _eq: true } }
      }
    ) {
      id
      workflow_id
      config
      workflow {
        id
        name
        # Used to avoid starting a second run for the same minute if the cron
        # trigger is delivered more than once.
        runs(
          where: { trigger_type: { _eq: "schedule" }, created_at: { _gte: $since } }
          limit: 1
        ) {
          id
        }
      }
    }
  }
`;

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  try {
    assertFromHasura(req);

    const now = new Date();
    const since = new Date(now.getTime() - 55_000).toISOString();

    const data = await adminGraphql<{
      workflow_triggers: {
        id: string;
        workflow_id: string;
        config: Record<string, unknown>;
        workflow: { id: string; name: string; runs: { id: string }[] };
      }[];
    }>(SCHEDULE_TRIGGERS, { since });

    const started: { workflow_id: string; run_id: string; status: string }[] = [];
    const skipped: { workflow_id: string; reason: string }[] = [];

    for (const trigger of data.workflow_triggers) {
      const expression = typeof trigger.config['cron'] === 'string' ? (trigger.config['cron'] as string) : '';

      if (!expression || !cronMatches(expression, now)) {
        continue;
      }
      if (trigger.workflow.runs.length > 0) {
        skipped.push({ workflow_id: trigger.workflow_id, reason: 'already started this minute' });
        continue;
      }

      const workflow = await loadWorkflowForTrigger(trigger.workflow_id);
      if (!workflow) continue;

      try {
        const result = await startRun({
          workflow,
          triggerType: 'schedule',
          triggeredBy: null,
          payload: { scheduled_for: now.toISOString(), cron: expression },
        });
        started.push({ workflow_id: workflow.id, run_id: result.runId, status: result.status });
      } catch (error) {
        skipped.push({
          workflow_id: trigger.workflow_id,
          reason: error instanceof Error ? error.message : 'failed to start run',
        });
      }
    }

    res.status(200).json({ evaluated_at: now.toISOString(), started, skipped });
  } catch (error) {
    respondWithError(res, error);
  }
}
