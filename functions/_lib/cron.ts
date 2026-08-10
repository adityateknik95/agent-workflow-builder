// Minimal 5-field cron matcher: minute, hour, day-of-month, month, day-of-week.
//
// Supports `*`, `*/n`, `a-b`, `a-b/n` and comma-separated lists of those. That
// covers everything a workflow schedule needs, and keeping it in-repo avoids a
// dependency in a serverless function for ~40 lines of logic.

interface Field {
  min: number;
  max: number;
}

const FIELDS: Field[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week, Sunday = 0
];

function matchesField(expression: string, value: number, field: Field): boolean {
  return expression.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;

    let start = field.min;
    let end = field.max;

    if (range !== '*' && range !== undefined) {
      const bounds = range.split('-');
      const from = Number(bounds[0]);
      if (!Number.isInteger(from)) return false;
      start = from;
      end = bounds.length > 1 ? Number(bounds[1]) : from;
      if (!Number.isInteger(end)) return false;
    }

    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}

/** True when `date` (UTC) falls on the minute described by `expression`. */
export function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];

  return parts.every((part, index) =>
    matchesField(part, values[index] as number, FIELDS[index] as Field)
  );
}
