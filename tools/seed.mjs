// Seeds the two organisations, their members, and a demo workflow in each.
//
// Users are created through nhost Auth (not by writing to auth.users), so the
// accounts printed at the end are real sign-ins. Everything else is written with
// the admin secret, the way a provisioning job would.
//
// Safe to re-run: orgs and members are upserted, and the demo workflows are
// replaced.
import 'dotenv/config';

const AUTH_URL = process.env.AUTH_URL ?? 'http://localhost:4000/v1';
const GRAPHQL_URL =
  process.env.NEXT_PUBLIC_GRAPHQL_URL ??
  `${(process.env.HASURA_GRAPHQL_ENDPOINT ?? 'http://localhost:8080').replace(/\/$/, '')}/v1/graphql`;
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
const PASSWORD = 'Password123!';

if (!ADMIN_SECRET) {
  console.error('HASURA_GRAPHQL_ADMIN_SECRET is not set. Copy .env.example to .env first.');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}

/** Signs a user up, or signs them in if the account already exists. */
async function ensureUser(email, displayName) {
  const signUp = await fetch(`${AUTH_URL}/signup/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, options: { displayName } }),
  });

  if (signUp.ok) {
    const body = await signUp.json();
    if (body.session?.user?.id) return body.session.user.id;
  }

  const signIn = await fetch(`${AUTH_URL}/signin/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  if (!signIn.ok) {
    throw new Error(`could not create or sign in ${email}: ${(await signIn.text()).slice(0, 300)}`);
  }
  const body = await signIn.json();
  if (!body.session?.user?.id) throw new Error(`no session returned for ${email}`);
  return body.session.user.id;
}

const UPSERT_ORG = /* GraphQL */ `
  mutation UpsertOrg($object: organizations_insert_input!) {
    insert_organizations_one(
      object: $object
      on_conflict: { constraint: organizations_slug_key, update_columns: [name, calls_allowed] }
    ) {
      id
      name
      slug
      calls_allowed
    }
  }
`;

const UPSERT_MEMBER = /* GraphQL */ `
  mutation UpsertMember($object: org_members_insert_input!) {
    insert_org_members_one(
      object: $object
      on_conflict: { constraint: org_members_org_user_key, update_columns: [role] }
    ) {
      id
      role
    }
  }
`;

const DELETE_WORKFLOW = /* GraphQL */ `
  mutation DeleteWorkflow($org_id: uuid!, $name: String!) {
    delete_workflows(where: { org_id: { _eq: $org_id }, name: { _eq: $name } }) {
      affected_rows
    }
  }
`;

const CREATE_WORKFLOW = /* GraphQL */ `
  mutation CreateWorkflow($object: workflows_insert_input!) {
    insert_workflows_one(object: $object) {
      id
      name
      triggers {
        type
        webhook_token
      }
    }
  }
`;

const RESET_USAGE = /* GraphQL */ `
  mutation ResetUsage($org_id: uuid!) {
    update_organizations_by_pk(pk_columns: { id: $org_id }, _set: { calls_used: 0 }) {
      calls_used
    }
  }
`;

async function main() {
  console.log('creating users through nhost Auth...');
  const users = {
    ownerA: await ensureUser('owner.a@example.com', 'Ada Okafor'),
    editorA: await ensureUser('editor.a@example.com', 'Mateo Ricci'),
    viewerA: await ensureUser('viewer.a@example.com', 'Priya Shah'),
    ownerB: await ensureUser('owner.b@example.com', 'Ben Halvorsen'),
    editorB: await ensureUser('editor.b@example.com', 'Sofia Lindqvist'),
  };

  console.log('creating organisations...');
  const orgA = (
    await gql(UPSERT_ORG, {
      object: { name: 'Northwind Labs', slug: 'northwind-labs', calls_allowed: 200 },
    })
  ).insert_organizations_one;

  const orgB = (
    await gql(UPSERT_ORG, {
      object: { name: 'Contoso Support', slug: 'contoso-support', calls_allowed: 50 },
    })
  ).insert_organizations_one;

  await gql(RESET_USAGE, { org_id: orgA.id });
  await gql(RESET_USAGE, { org_id: orgB.id });

  console.log('assigning members...');
  const memberships = [
    [orgA.id, users.ownerA, 'owner'],
    [orgA.id, users.editorA, 'editor'],
    [orgA.id, users.viewerA, 'viewer'],
    [orgB.id, users.ownerB, 'owner'],
    [orgB.id, users.editorB, 'editor'],
  ];
  for (const [org_id, user_id, role] of memberships) {
    await gql(UPSERT_MEMBER, { object: { org_id, user_id, role } });
  }

  // ---------------------------------------------------------------------------
  // Org A's demo workflow.
  //
  // Every step's created_by is the owner, which matters for db_write and notify:
  // the executor re-checks at run time that their author still holds owner.
  //
  // The step configs read from {{trigger.row.*}}, which is the shape all four
  // trigger types produce -- the Run dialog, the webhook payload, and the
  // inbound_leads row from the database Event Trigger.
  // ---------------------------------------------------------------------------
  const workflowName = 'Inbound lead triage';
  await gql(DELETE_WORKFLOW, { org_id: orgA.id, name: workflowName });

  const workflowA = (
    await gql(CREATE_WORKFLOW, {
      object: {
        org_id: orgA.id,
        name: workflowName,
        description:
          'Classifies an inbound lead with an LLM, branches on the urgency it reports, ' +
          'pauses for a human on the urgent path, then records and announces the outcome.',
        created_by: users.ownerA,
        steps: {
          data: [
            {
              position: 1,
              type: 'llm_call',
              name: 'Classify inbound lead',
              created_by: users.ownerA,
              config: {
                system:
                  'You triage inbound sales and support messages. Reply with JSON only, using the keys ' +
                  'urgency ("high" or "low"), summary, recommended_action and confidence.',
                prompt:
                  'Classify this inbound message.\n\n' +
                  'From: {{trigger.row.email}}\n' +
                  'Company: {{trigger.row.company}}\n' +
                  'Message: {{trigger.row.message}}',
                max_tokens: 300,
                temperature: 0.1,
              },
            },
            {
              position: 2,
              type: 'conditional_branch',
              name: 'Route on urgency',
              created_by: users.ownerA,
              config: {
                source: 'steps.1.output.json.urgency',
                operator: 'equals',
                value: 'high',
                case_sensitive: false,
                // Urgent leads go through the approval gate at 3; everything else
                // jumps straight to the recording step at 5.
                on_true: { goto: 3 },
                on_false: { goto: 5 },
              },
            },
            {
              position: 3,
              type: 'approval_gate',
              name: 'Human sign-off for urgent lead',
              created_by: users.ownerA,
              config: {
                instructions:
                  'This lead was classified as high urgency. Approve to open a ticket in the external ' +
                  'tracker and alert the team, or reject to stop the run.',
                allowed_roles: ['owner', 'editor'],
              },
            },
            {
              position: 4,
              type: 'http_request',
              name: 'Open ticket in external tracker',
              created_by: users.ownerA,
              config: {
                method: 'POST',
                url: 'https://jsonplaceholder.typicode.com/posts',
                headers: { 'content-type': 'application/json' },
                body: {
                  title: 'Urgent lead: {{trigger.row.company}}',
                  body: '{{steps.1.output.json.summary}}',
                  userId: 1,
                },
                expect_status: [200, 201],
                timeout_ms: 15000,
              },
            },
            {
              position: 5,
              type: 'db_write',
              name: 'Store triage decision',
              created_by: users.ownerA,
              config: {
                key: 'lead_triage',
                payload: {
                  email: '{{trigger.row.email}}',
                  company: '{{trigger.row.company}}',
                  urgency: '{{steps.1.output.json.urgency}}',
                  summary: '{{steps.1.output.json.summary}}',
                  ticket_id: '{{steps.4.output.body.id}}',
                },
              },
            },
            {
              position: 6,
              type: 'notify',
              name: 'Post summary to #sales',
              created_by: users.ownerA,
              config: {
                channel: 'slack',
                target: '#sales',
                subject: 'Lead triaged: {{trigger.row.company}}',
                body:
                  'Urgency {{steps.1.output.json.urgency}} for {{trigger.row.email}}.\n' +
                  '{{steps.1.output.json.summary}}',
              },
            },
          ],
        },
        triggers: {
          data: [
            { type: 'manual', created_by: users.ownerA, config: {} },
            { type: 'webhook', created_by: users.ownerA, config: { description: 'Website contact form' } },
            {
              type: 'database_event',
              created_by: users.ownerA,
              config: { table: 'inbound_leads' },
            },
            {
              // Present and working, but off by default so a checked-out copy does
              // not quietly spend the org's quota every five minutes.
              type: 'schedule',
              created_by: users.ownerA,
              is_enabled: false,
              config: { cron: '*/5 * * * *' },
            },
          ],
        },
      },
    })
  ).insert_workflows_one;

  // Org B gets its own workflow so cross-org checks have something real on both sides.
  const workflowBName = 'Ticket backlog summary';
  await gql(DELETE_WORKFLOW, { org_id: orgB.id, name: workflowBName });
  const workflowB = (
    await gql(CREATE_WORKFLOW, {
      object: {
        org_id: orgB.id,
        name: workflowBName,
        description: 'Summarises the current support backlog for the daily standup.',
        created_by: users.ownerB,
        steps: {
          data: [
            {
              position: 1,
              type: 'llm_call',
              name: 'Summarise backlog',
              created_by: users.ownerB,
              config: {
                prompt: 'Summarise the open support backlog for {{trigger.row.company}}.',
                max_tokens: 200,
              },
            },
            {
              position: 2,
              type: 'db_write',
              name: 'Store standup note',
              created_by: users.ownerB,
              config: { key: 'standup_note', payload: { note: '{{steps.1.output.text}}' } },
            },
          ],
        },
        triggers: { data: [{ type: 'manual', created_by: users.ownerB, config: {} }] },
      },
    })
  ).insert_workflows_one;

  const webhookToken = workflowA.triggers.find((t) => t.type === 'webhook')?.webhook_token;

  console.log('\n--- seeded ---------------------------------------------------');
  console.log(`Org A  ${orgA.name} (${orgA.slug})  quota ${orgA.calls_allowed}/period`);
  console.log(`Org B  ${orgB.name} (${orgB.slug})  quota ${orgB.calls_allowed}/period`);
  console.log('\nsign in with any of these (password for all: %s):', PASSWORD);
  console.log('  owner.a@example.com    owner  in Northwind Labs');
  console.log('  editor.a@example.com   editor in Northwind Labs');
  console.log('  viewer.a@example.com   viewer in Northwind Labs');
  console.log('  owner.b@example.com    owner  in Contoso Support');
  console.log('  editor.b@example.com   editor in Contoso Support');
  console.log(`\nOrg A workflow  ${workflowA.name}  ${workflowA.id}`);
  console.log(`Org B workflow  ${workflowB.name}  ${workflowB.id}`);
  console.log(`\nwebhook token   ${webhookToken}`);
  console.log('start a run from outside the app with:');
  console.log(`  curl -X POST ${GRAPHQL_URL} \\
    -H 'content-type: application/json' \\
    -d '{"query":"mutation(\\$t:String!,\\$p:jsonb){startWorkflowFromWebhook(token:\\$t,payload:\\$p){workflow_run_id status accepted message}}","variables":{"t":"${webhookToken}","payload_note":"see README","p":{"row":{"email":"ops@acme.test","company":"Acme","message":"Our integration is down, this is urgent"}}}}'`);
  console.log('--------------------------------------------------------------\n');
}

main().catch((error) => {
  console.error('\nseed failed:', error.message);
  process.exitCode = 1;
});
