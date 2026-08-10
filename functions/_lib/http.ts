// Small helpers shared by every handler: the webhook-secret gate, the error shape
// Hasura expects back from an Action, and a fetch with a timeout.
import { config } from './config';
import type { FnRequest, FnResponse } from './types';

/** Error carrying the code that should end up in the GraphQL error extensions. */
export class HandlerError extends Error {
  constructor(
    message: string,
    readonly code: string = 'bad-request',
    readonly httpStatus: number = 400
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

function headerValue(req: FnRequest, name: string): string | undefined {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Every Action and Event Trigger in the metadata sends
 * `x-nhost-webhook-secret`. Without this check the handler URLs would be an
 * unauthenticated way to start runs and write step results, since the handlers
 * themselves hold the admin secret.
 */
export function assertFromHasura(req: FnRequest): void {
  if (!config.webhookSecret) {
    throw new HandlerError('handler is missing NHOST_WEBHOOK_SECRET', 'misconfigured', 500);
  }
  if (headerValue(req, 'x-nhost-webhook-secret') !== config.webhookSecret) {
    throw new HandlerError('request did not come from Hasura', 'forbidden', 403);
  }
}

/** Turns any thrown value into the response body Hasura renders as a GraphQL error. */
export function respondWithError(res: FnResponse, error: unknown): void {
  if (error instanceof HandlerError) {
    res.status(error.httpStatus).json({
      message: error.message,
      extensions: { code: error.code },
    });
    return;
  }

  const message = error instanceof Error ? error.message : 'unexpected handler failure';
  console.error('[handler] unhandled failure:', error);
  res.status(500).json({ message, extensions: { code: 'internal-error' } });
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
