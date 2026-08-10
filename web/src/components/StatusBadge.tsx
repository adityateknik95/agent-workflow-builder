'use client';

const TONE: Record<string, string> = {
  succeeded: 'ok',
  running: 'run',
  pending: '',
  paused: 'paused',
  failed: 'bad',
  rejected: 'bad',
  cancelled: 'bad',
  skipped: '',
  sent: 'ok',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${TONE[status] ?? ''}`}>{label ?? status}</span>;
}
