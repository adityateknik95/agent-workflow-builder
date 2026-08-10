// Runtime configuration. nhost injects NHOST_* variables into deployed
// functions; the HASURA_* names are what docker-compose and the local dev server
// use. Either set works.

function firstOf(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  return '';
}

const backendUrl = firstOf('NHOST_BACKEND_URL', 'HASURA_GRAPHQL_ENDPOINT') || 'http://localhost:8080';

export const config = {
  graphqlUrl:
    firstOf('NHOST_GRAPHQL_URL', 'HASURA_GRAPHQL_URL') || `${backendUrl.replace(/\/$/, '')}/v1/graphql`,

  adminSecret: firstOf('NHOST_ADMIN_SECRET', 'HASURA_GRAPHQL_ADMIN_SECRET'),

  // Shared secret Hasura sends on every Action / Event Trigger call. Handlers
  // refuse requests without it, so the function URLs are not an open API.
  webhookSecret: firstOf('NHOST_WEBHOOK_SECRET'),

  llm: {
    provider: (firstOf('LLM_PROVIDER') || 'stub').toLowerCase(),
    apiKey: firstOf('LLM_API_KEY'),
    model: firstOf('LLM_MODEL') || 'llama-3.3-70b-versatile',
  },

  slackWebhookUrl: firstOf('SLACK_WEBHOOK_URL'),

  // How many attempts a retryable step gets by default (2 = one retry).
  defaultMaxAttempts: Number(firstOf('STEP_MAX_ATTEMPTS') || '2'),
};

if (!config.adminSecret) {
  console.warn('[config] no admin secret found; GraphQL calls will be rejected');
}
