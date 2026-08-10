// Admin-rights GraphQL client.
//
// The handlers run privileged work -- creating runs, writing step results,
// charging quota -- that no client role is allowed to do, so they talk to Hasura
// with the admin secret. Every place where a *user's* rights matter, the handler
// checks them explicitly against org_members (see authz.ts) rather than relying
// on the connection's rights.
import { config } from './config';

export class GraphQLRequestError extends Error {
  constructor(message: string, readonly errors: unknown) {
    super(message);
    this.name = 'GraphQLRequestError';
  }
}

export async function adminGraphql<TData>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<TData> {
  const response = await fetch(config.graphqlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': config.adminSecret,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as { data?: TData; errors?: unknown[] };

  if (payload.errors?.length) {
    const first = payload.errors[0] as { message?: string };
    throw new GraphQLRequestError(first?.message ?? 'GraphQL request failed', payload.errors);
  }
  if (!response.ok || !payload.data) {
    throw new GraphQLRequestError(`GraphQL request failed with status ${response.status}`, payload.errors);
  }

  return payload.data;
}
