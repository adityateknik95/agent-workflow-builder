'use client';

import { useSubscription } from '@/lib/graphql';
import { USAGE_SUBSCRIPTION } from '@/lib/documents';
import type { OrgRole } from '@/lib/session';

interface UsageRow {
  calls_used: number;
  calls_allowed: number;
  calls_remaining: number;
  period_start: string;
  runs_this_period: number;
  paused_runs: number;
  avg_run_duration_seconds: number | null;
}

/**
 * Live quota readout, backed by the org_usage_summary view (the project's
 * aggregation). It is a subscription rather than a query, so the number moves as
 * runs spend calls without anyone reloading.
 */
export function QuotaIndicator({ orgId, role }: { orgId: string; role: OrgRole | null }) {
  const { data } = useSubscription<{ org_usage_summary: UsageRow[] }>(
    USAGE_SUBSCRIPTION,
    { org_id: orgId },
    { role: role ?? undefined, skip: !role }
  );

  const usage = data?.org_usage_summary?.[0];
  if (!usage) return null;

  const ratio = usage.calls_allowed > 0 ? usage.calls_used / usage.calls_allowed : 0;
  const level = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'warn' : '';

  return (
    <div
      className="row"
      title={
        `${usage.runs_this_period} run(s) this period` +
        (usage.avg_run_duration_seconds ? `, averaging ${usage.avg_run_duration_seconds}s` : '') +
        (usage.paused_runs ? `, ${usage.paused_runs} awaiting approval` : '')
      }
      style={{ gap: '0.45rem' }}
    >
      <span className="muted small">quota</span>
      <div className={`meter ${level}`}>
        <span style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
      </div>
      <span className="small mono">
        {usage.calls_used}/{usage.calls_allowed}
      </span>
    </div>
  );
}
