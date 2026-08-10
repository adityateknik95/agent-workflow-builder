// Shared types for the handlers.
//
// The request/response shapes are declared locally rather than imported from
// express: nhost runs these handlers behind express, but nothing here needs more
// of it than the four members below, and keeping it explicit means the same files
// run unchanged under the local dev server in tools/.

export interface FnRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FnResponse {
  status(code: number): FnResponse;
  json(body: unknown): void;
  send(body?: unknown): void;
}

export type StepType =
  | 'llm_call'
  | 'http_request'
  | 'db_write'
  | 'notify'
  | 'conditional_branch'
  | 'approval_gate';

export type TriggerType = 'manual' | 'webhook' | 'schedule' | 'database_event';

export type RunStatus = 'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'skipped';

export type OrgRole = 'owner' | 'editor' | 'viewer';

export interface StepDefinition {
  id: string;
  position: number;
  type: StepType;
  name: string;
  config: Record<string, unknown>;
  created_by: string | null;
}

export interface StepRunRow {
  id: string;
  workflow_step_id: string | null;
  position: number;
  status: StepRunStatus;
  output: unknown;
  attempt: number;
}

/** Where the loop goes after a step. */
export type NextInstruction =
  | { kind: 'continue' }
  | { kind: 'goto'; position: number }
  | { kind: 'end' };

export interface StepOutcome {
  output: Record<string, unknown>;
  next?: NextInstruction;
}

/** Session variables Hasura sends with an Action call. */
export interface SessionVariables {
  'x-hasura-user-id'?: string;
  'x-hasura-role'?: string;
  [key: string]: string | undefined;
}

export interface ActionPayload<TInput> {
  action: { name: string };
  input: TInput;
  session_variables: SessionVariables;
  request_query?: string;
}
