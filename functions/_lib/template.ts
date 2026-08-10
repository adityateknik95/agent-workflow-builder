// {{ path }} interpolation for step configs.
//
// A step's config can reference the run's trigger payload and any earlier step's
// output, e.g.
//
//   {{ trigger.email }}
//   {{ steps.1.output.text }}
//   {{ steps.classify_inbound_lead.output.json.urgency }}
//
// Steps are addressable by position and by a slug of their name, which keeps
// configs readable when positions get reordered.

export type TemplateData = Record<string, unknown>;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function resolvePath(data: TemplateData, path: string): unknown {
  const segments = path
    .trim()
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Replaces every {{ path }} in a string. Unresolved paths become empty strings. */
export function renderTemplate(template: string, data: TemplateData): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) =>
    stringify(resolvePath(data, path))
  );
}

/**
 * Renders templates throughout a value. A string that is exactly one placeholder
 * keeps the resolved value's type, so `{"limit": "{{trigger.limit}}"}` can yield a
 * number rather than the string "5".
 */
export function renderDeep(value: unknown, data: TemplateData): unknown {
  if (typeof value === 'string') {
    const exact = /^\s*\{\{([^{}]+)\}\}\s*$/.exec(value);
    if (exact) {
      const resolved = resolvePath(data, exact[1] as string);
      return resolved === undefined ? null : resolved;
    }
    return renderTemplate(value, data);
  }
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, data));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renderDeep(item, data)])
    );
  }
  return value;
}

/** Parses a string as JSON when it looks like JSON, tolerating ```json fences. */
export function tryParseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();

  if (!/^[[{]/.test(cleaned)) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
