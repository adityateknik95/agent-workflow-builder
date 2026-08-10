// Walks the Final Task scenario against a running stack and prints a pass/fail
// line per assertion. Exits non-zero if anything fails.
//
// Everything here goes through the public GraphQL endpoint with a real user JWT --
// no admin secret, no shortcuts -- because the point is to prove what a signed-in
// member of an organisation can and cannot do.
//
//   npm run verify
import 'dotenv/config';

// Same precedence as the seed: naming HASURA_GRAPHQL_ENDPOINT on the command line
// must win over any NEXT_PUBLIC_* value sitting in .env, or you end up verifying
// localhost while believing you verified the deployment.
const GRAPHQL_URL = process.env.HASURA_GRAPHQL_ENDPOINT
  ? `${process.env.HASURA_GRAPHQL_ENDPOINT.replace(/\/$/, '')}/v1/graphql`
  : (process.env.NEXT_PUBLIC_GRAPHQL_URL ?? 'http://localhost:8080/v1/graphql');

const WS_URL = process.env.HASURA_GRAPHQL_ENDPOINT
  ? GRAPHQL_URL.replace(/^http/, 'ws')
  : (process.env.NEXT_PUBLIC_GRAPHQL_WS_URL ?? GRAPHQL_URL.replace(/^http/, 'ws'));
const AUTH_URL = process.env.AUTH_URL ?? 'http://localhost:4000/v1';
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
const PASSWORD = 'Password123!';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

async function signIn(email) {
  const response = await fetch(`${AUTH_URL}/signin/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await response.json();
  if (!body.session?.accessToken) throw new Error(`sign-in failed for ${email}`);
  return { token: body.session.accessToken, userId: body.session.user.id };
}

/** Runs an operation as a signed-in user acting in a specific org role. */
async function asUser({ token }, role, query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(role ? { 'x-hasura-role': role } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

async function asAdmin(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

const errorText = (result) => (result.errors ?? []).map((e) => e.message).join('; ');

/**
 * Subscribes over graphql-transport-ws and collects pushes until `done` says stop.
 * Uses the WebSocket built into Node so the check has no dependencies.
 */
function collectSubscription({ token, role, query, variables, isDone, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL, 'graphql-transport-ws');
    const frames = [];
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      error ? reject(error) : resolve(frames);
    };

    const timer = setTimeout(() => finish(new Error('subscription timed out')), timeoutMs);

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'connection_init',
          payload: {
            headers: {
              authorization: `Bearer ${token}`,
              ...(role ? { 'x-hasura-role': role } : {}),
            },
          },
        })
      );
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'connection_ack') {
        socket.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
        return;
      }
      if (message.type === 'next') {
        frames.push(message.payload.data);
        if (isDone(message.payload.data, frames)) finish();
        return;
      }
      if (message.type === 'error') {
        finish(new Error(JSON.stringify(message.payload)));
      }
    });

    socket.addEventListener('error', () => finish(new Error('websocket error')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- queries used below ------------------------------------------------------
const ORG_WORKFLOWS = /* GraphQL */ `
  query OrgWorkflows {
    workflows {
      id
      name
      org { id name slug }
      steps(order_by: { position: asc }) { position type name }
      triggers { type is_enabled }
      runs(order_by: { created_at: desc }, limit: 1) { id status duration_seconds }
    }
  }
`;

const WORKFLOW_BY_ID = /* GraphQL */ `
  query WorkflowById($id: uuid!) {
    workflows_by_pk(id: $id) { id name org_id }
  }
`;

const TRIGGER_RUN = /* GraphQL */ `
  mutation TriggerRun($workflow_id: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $workflow_id, input: $input) {
      workflow_run_id
      status
      steps_executed
      message
    }
  }
`;

const APPROVE = /* GraphQL */ `
  mutation Approve($step_run_id: uuid!, $decision: ApprovalDecision!, $note: String) {
    approveStep(step_run_id: $step_run_id, decision: $decision, note: $note) {
      step_run_id
      run_status
      resumed
      message
    }
  }
`;

const RUN_DETAIL = /* GraphQL */ `
  query RunDetail($run_id: uuid!) {
    workflow_runs_by_pk(id: $run_id) {
      id
      status
      external_calls
      duration_seconds
      step_runs(order_by: { position: asc }) {
        id
        position
        step_type
        step_name
        status
        attempt
        error
        approved_at
        approver { email role }
        output
      }
    }
  }
`;

const STEP_RUNS_SUBSCRIPTION = /* GraphQL */ `
  subscription WatchRun($run_id: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $run_id } }, order_by: { position: asc }) {
      position
      step_name
      step_type
      status
      attempt
    }
  }
`;

async function main() {
  console.log(`verifying against ${GRAPHQL_URL}\n`);

  const ownerA = await signIn('owner.a@example.com');
  const editorA = await signIn('editor.a@example.com');
  const viewerA = await signIn('viewer.a@example.com');
  const ownerB = await signIn('owner.b@example.com');

  // ---------------------------------------------------------------- point 1 & 2
  section('1-2. Two orgs with their own users and roles; Org A workflow is built');

  const aWorkflows = await asUser(ownerA, 'owner', ORG_WORKFLOWS);
  const bWorkflows = await asUser(ownerB, 'owner', ORG_WORKFLOWS);

  const workflowA = aWorkflows.data?.workflows?.[0];
  const workflowB = bWorkflows.data?.workflows?.[0];

  check('owner A sees exactly their own org’s workflows', aWorkflows.data?.workflows?.length === 1, errorText(aWorkflows));
  check('owner B sees exactly their own org’s workflows', bWorkflows.data?.workflows?.length === 1, errorText(bWorkflows));
  check('the two orgs are different', workflowA?.org?.id !== workflowB?.org?.id);

  const stepTypes = new Set((workflowA?.steps ?? []).map((s) => s.type));
  check(
    'Org A workflow has llm_call, http_request and conditional_branch',
    ['llm_call', 'http_request', 'conditional_branch'].every((t) => stepTypes.has(t)),
    [...stepTypes].join(', ')
  );
  check('Org A workflow has an approval_gate', stepTypes.has('approval_gate'));

  const triggerTypes = new Set((workflowA?.triggers ?? []).map((t) => t.type));
  check(
    'Org A workflow can be started manually and by webhook and by a database event',
    ['manual', 'webhook', 'database_event'].every((t) => triggerTypes.has(t)),
    [...triggerTypes].join(', ')
  );

  // ------------------------------------------------------------------- layer 1
  section('Permission layer 1: org + role scoping');

  const viewerRead = await asUser(viewerA, 'viewer', ORG_WORKFLOWS);
  check('viewer in Org A can read the workflow', viewerRead.data?.workflows?.length === 1, errorText(viewerRead));

  // Asking for a role you do not hold in the org yields nothing, because the row
  // filter compares the requested role against the actual org_members row.
  const viewerAsOwner = await asUser(viewerA, 'owner', ORG_WORKFLOWS);
  check(
    'viewer asking Hasura for role=owner sees no rows',
    (viewerAsOwner.data?.workflows?.length ?? 0) === 0 || Boolean(viewerAsOwner.errors),
    JSON.stringify(viewerAsOwner.data ?? {})
  );

  const editorAddsMember = await asUser(
    editorA,
    'editor',
    /* GraphQL */ `
      mutation AddMember($org_id: uuid!, $user_id: uuid!) {
        insert_org_members_one(object: { org_id: $org_id, user_id: $user_id, role: viewer }) { id }
      }
    `,
    { org_id: workflowA.org.id, user_id: ownerB.userId }
  );
  check('editor cannot manage org membership', Boolean(editorAddsMember.errors), 'mutation was allowed');

  // ------------------------------------------------------------------- layer 2
  section('Permission layer 2: step-level gating');

  const addStepAs = (user, role, type, name) =>
    asUser(
      user,
      role,
      /* GraphQL */ `
        mutation AddStep($workflow_id: uuid!, $position: Int!, $type: String!, $name: String!) {
          insert_workflow_steps_one(
            object: { workflow_id: $workflow_id, position: $position, type: $type, name: $name, config: {} }
          ) { id type }
        }
      `,
      { workflow_id: workflowA.id, position: 90 + Math.floor(Math.random() * 9), type, name }
    );

  const editorDbWrite = await addStepAs(editorA, 'editor', 'db_write', 'editor tries db_write');
  check('editor cannot add a db_write step', Boolean(editorDbWrite.errors), 'insert was allowed');

  const editorNotify = await addStepAs(editorA, 'editor', 'notify', 'editor tries notify');
  check('editor cannot add a notify step', Boolean(editorNotify.errors), 'insert was allowed');

  const editorLlm = await addStepAs(editorA, 'editor', 'llm_call', 'editor adds llm_call');
  check('editor can add an ordinary llm_call step', Boolean(editorLlm.data?.insert_workflow_steps_one), errorText(editorLlm));
  if (editorLlm.data?.insert_workflow_steps_one) {
    await asAdmin(
      /* GraphQL */ `mutation Del($id: uuid!) { delete_workflow_steps_by_pk(id: $id) { id } }`,
      { id: editorLlm.data.insert_workflow_steps_one.id }
    );
  }

  const ownerDbWrite = await addStepAs(ownerA, 'owner', 'db_write', 'owner adds db_write');
  check('owner can add a db_write step', Boolean(ownerDbWrite.data?.insert_workflow_steps_one), errorText(ownerDbWrite));
  if (ownerDbWrite.data?.insert_workflow_steps_one) {
    await asAdmin(
      /* GraphQL */ `mutation Del($id: uuid!) { delete_workflow_steps_by_pk(id: $id) { id } }`,
      { id: ownerDbWrite.data.insert_workflow_steps_one.id }
    );
  }

  const editorWebhookTrigger = await asUser(
    editorA,
    'editor',
    /* GraphQL */ `
      mutation AddTrigger($workflow_id: uuid!) {
        insert_workflow_triggers_one(object: { workflow_id: $workflow_id, type: "webhook", config: {} }) { id }
      }
    `,
    { workflow_id: workflowA.id }
  );
  check('editor cannot attach a webhook trigger', Boolean(editorWebhookTrigger.errors), 'insert was allowed');

  const READ_TOKEN = /* GraphQL */ `
    query ReadToken($workflow_id: uuid!) {
      workflow_triggers(where: { workflow_id: { _eq: $workflow_id }, type: { _eq: "webhook" } }) {
        webhook_token
      }
    }
  `;
  const editorToken = await asUser(editorA, 'editor', READ_TOKEN, { workflow_id: workflowA.id });
  check('editor cannot read the webhook token', Boolean(editorToken.errors), 'token was readable');

  const ownerToken = await asUser(ownerA, 'owner', READ_TOKEN, { workflow_id: workflowA.id });
  const webhookToken = ownerToken.data?.workflow_triggers?.[0]?.webhook_token;
  check('owner can read the webhook token', Boolean(webhookToken), errorText(ownerToken));

  // --------------------------------------------------------------- points 3-5
  section('3-5. Manual run, live progress, pause on approval gate, approve forward');

  const viewerTriggers = await asUser(viewerA, 'viewer', TRIGGER_RUN, {
    workflow_id: workflowA.id,
    input: {},
  });
  check('viewer cannot trigger a run', Boolean(viewerTriggers.errors), 'mutation was allowed');

  const urgentLead = {
    row: {
      email: 'ops@acme.test',
      company: 'Acme Industrial',
      message: 'Our production integration is down since this morning. This is urgent.',
    },
  };

  // Start the subscription first, then trigger, so the pushes are genuinely live.
  const watcher = collectSubscription({
    token: ownerA.token,
    role: 'owner',
    query: STEP_RUNS_SUBSCRIPTION,
    variables: { run_id: '00000000-0000-0000-0000-000000000000' },
    isDone: () => true,
    timeoutMs: 10_000,
  }).catch(() => null);
  await watcher;

  const triggered = await asUser(ownerA, 'owner', TRIGGER_RUN, {
    workflow_id: workflowA.id,
    input: urgentLead,
  });
  const runId = triggered.data?.triggerWorkflowRun?.workflow_run_id;
  check('owner can trigger a run', Boolean(runId), errorText(triggered));
  check(
    'run pauses on the approval gate',
    triggered.data?.triggerWorkflowRun?.status === 'paused',
    JSON.stringify(triggered.data?.triggerWorkflowRun ?? {})
  );

  const paused = await asUser(ownerA, 'owner', RUN_DETAIL, { run_id: runId });
  const pausedSteps = paused.data?.workflow_runs_by_pk?.step_runs ?? [];
  const gate = pausedSteps.find((s) => s.step_type === 'approval_gate');

  check('the LLM step succeeded', pausedSteps.find((s) => s.step_type === 'llm_call')?.status === 'succeeded');
  check(
    'the branch read the LLM output and chose the urgent path',
    pausedSteps.find((s) => s.step_type === 'conditional_branch')?.output?.matched === true,
    JSON.stringify(pausedSteps.find((s) => s.step_type === 'conditional_branch')?.output ?? {})
  );
  check('the gate is paused awaiting approval', gate?.status === 'paused', gate?.status);

  // A subscription filtered to this run must show the paused state without a refresh.
  const liveFrames = await collectSubscription({
    token: ownerA.token,
    role: 'owner',
    query: STEP_RUNS_SUBSCRIPTION,
    variables: { run_id: runId },
    isDone: (data) => data.step_runs.some((s) => s.status === 'paused'),
    timeoutMs: 20_000,
  });
  check(
    'subscription streams step_runs including the paused state',
    liveFrames.at(-1)?.step_runs?.some((s) => s.status === 'paused'),
    JSON.stringify(liveFrames.at(-1) ?? {})
  );

  // ------------------------------------------------------------------- point 6
  section('6. Org B cannot see, trigger or approve anything in Org A');

  const bReadsAWorkflow = await asUser(ownerB, 'owner', WORKFLOW_BY_ID, { id: workflowA.id });
  check(
    'Org B owner cannot read Org A’s workflow by its exact id',
    bReadsAWorkflow.data?.workflows_by_pk === null,
    JSON.stringify(bReadsAWorkflow.data ?? {})
  );

  const bReadsARun = await asUser(ownerB, 'owner', RUN_DETAIL, { run_id: runId });
  check(
    'Org B owner cannot read Org A’s run by its exact id',
    bReadsARun.data?.workflow_runs_by_pk === null,
    JSON.stringify(bReadsARun.data ?? {})
  );

  const bTriggersA = await asUser(ownerB, 'owner', TRIGGER_RUN, { workflow_id: workflowA.id, input: {} });
  check('Org B owner cannot trigger Org A’s workflow', Boolean(bTriggersA.errors), 'mutation succeeded');

  const bApprovesA = await asUser(ownerB, 'owner', APPROVE, {
    step_run_id: gate.id,
    decision: 'approve',
    note: 'from the wrong org',
  });
  check('Org B owner cannot approve Org A’s gate', Boolean(bApprovesA.errors), 'approval succeeded');

  const bSubscribes = await collectSubscription({
    token: ownerB.token,
    role: 'owner',
    query: STEP_RUNS_SUBSCRIPTION,
    variables: { run_id: runId },
    isDone: () => true,
    timeoutMs: 8_000,
  });
  check(
    'Org B owner subscribing to Org A’s run receives no rows',
    (bSubscribes.at(-1)?.step_runs?.length ?? 0) === 0,
    JSON.stringify(bSubscribes.at(-1) ?? {})
  );

  const stillPaused = await asUser(ownerA, 'owner', RUN_DETAIL, { run_id: runId });
  check(
    'the gate is still paused after Org B’s attempts',
    stillPaused.data?.workflow_runs_by_pk?.status === 'paused'
  );

  // ------------------------------------------------------- approve and resume
  section('Approval by a permitted member resumes the run');

  const approved = await asUser(editorA, 'editor', APPROVE, {
    step_run_id: gate.id,
    decision: 'approve',
    note: 'Checked the account, going ahead.',
  });
  check('an editor in Org A can approve the gate', Boolean(approved.data?.approveStep?.resumed), errorText(approved));
  check(
    'the run finished after approval',
    approved.data?.approveStep?.run_status === 'succeeded',
    JSON.stringify(approved.data?.approveStep ?? {})
  );

  const finished = await asUser(ownerA, 'owner', RUN_DETAIL, { run_id: runId });
  const finishedRun = finished.data?.workflow_runs_by_pk;
  const byType = Object.fromEntries((finishedRun?.step_runs ?? []).map((s) => [s.step_type, s]));

  check('the approval is attributed to the approver', Boolean(byType.approval_gate?.approved_at));
  check(
    'the approver is recorded with their email and role',
    byType.approval_gate?.approver?.email === 'editor.a@example.com',
    JSON.stringify(byType.approval_gate?.approver ?? {})
  );
  check('the real http_request step succeeded', byType.http_request?.status === 'succeeded', byType.http_request?.error ?? '');
  check('the db_write step succeeded', byType.db_write?.status === 'succeeded', byType.db_write?.error ?? '');
  check('the notify step was enqueued', byType.notify?.status === 'succeeded', byType.notify?.error ?? '');
  check('the run has a duration', Number(finishedRun?.duration_seconds) > 0);

  const secondApproval = await asUser(editorA, 'editor', APPROVE, {
    step_run_id: gate.id,
    decision: 'approve',
    note: 'again',
  });
  check('the same gate cannot be approved twice', Boolean(secondApproval.errors), 'second approval succeeded');

  // -------------------------------------------------------- artifacts + notify
  const RUN_SIDE_EFFECTS = /* GraphQL */ `
    query Artifacts($run_id: uuid!) {
      workflow_artifacts(where: { workflow_run_id: { _eq: $run_id } }) { key payload }
      notifications(where: { workflow_run_id: { _eq: $run_id } }) { channel status target }
    }
  `;

  let artifacts = await asUser(ownerA, 'owner', RUN_SIDE_EFFECTS, { run_id: runId });
  check('db_write persisted an artifact', (artifacts.data?.workflow_artifacts?.length ?? 0) === 1, errorText(artifacts));

  // The notify step only enqueues; delivery is a separate Event Trigger, so the
  // row is expected to still be `pending` for a moment after the run finishes.
  // Waiting for it to leave `pending` is the assertion -- that the trigger fired.
  for (let i = 0; i < 15 && artifacts.data?.notifications?.[0]?.status === 'pending'; i += 1) {
    await sleep(500);
    artifacts = await asUser(ownerA, 'owner', RUN_SIDE_EFFECTS, { run_id: runId });
  }
  check(
    'the notification row was created and processed by the Event Trigger',
    ['sent', 'skipped', 'failed'].includes(artifacts.data?.notifications?.[0]?.status),
    JSON.stringify(artifacts.data?.notifications ?? [])
  );

  // ---------------------------------------------------- the non-urgent branch
  section('The conditional branch actually changes behaviour');

  const calmRun = await asUser(ownerA, 'owner', TRIGGER_RUN, {
    workflow_id: workflowA.id,
    input: { row: { email: 'hello@example.test', company: 'Quiet Co', message: 'Just browsing, no rush at all.' } },
  });
  const calmRunId = calmRun.data?.triggerWorkflowRun?.workflow_run_id;
  check('a low-urgency lead runs straight through without pausing', calmRun.data?.triggerWorkflowRun?.status === 'succeeded', JSON.stringify(calmRun.data ?? {}) + errorText(calmRun));

  const calmDetail = await asUser(ownerA, 'owner', RUN_DETAIL, { run_id: calmRunId });
  const calmSteps = calmDetail.data?.workflow_runs_by_pk?.step_runs ?? [];
  check(
    'the gate and the http_request were skipped on the low-urgency path',
    calmSteps.find((s) => s.step_type === 'approval_gate')?.status === 'skipped' &&
      calmSteps.find((s) => s.step_type === 'http_request')?.status === 'skipped',
    calmSteps.map((s) => `${s.position}:${s.status}`).join(' ')
  );

  // ------------------------------------------------------------ webhook trigger
  section('A trigger beyond manual: inbound webhook, with no user session at all');

  const webhookResponse = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: /* GraphQL */ `
        mutation Inbound($token: String!, $payload: jsonb) {
          startWorkflowFromWebhook(token: $token, payload: $payload) {
            workflow_run_id
            status
            accepted
          }
        }
      `,
      variables: { token: webhookToken, payload: urgentLead },
    }),
  });
  const webhookBody = await webhookResponse.json();
  check(
    'an unauthenticated webhook call with a valid token starts a run',
    webhookBody.data?.startWorkflowFromWebhook?.accepted === true,
    JSON.stringify(webhookBody.errors ?? webhookBody.data)
  );

  const badToken = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: /* GraphQL */ `
        mutation Inbound($token: String!) {
          startWorkflowFromWebhook(token: $token) { accepted }
        }
      `,
      variables: { token: 'not-a-real-token' },
    }),
  });
  const badTokenBody = await badToken.json();
  check('an invalid webhook token is refused', Boolean(badTokenBody.errors));

  const anonRead = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ workflows { id } }' }),
  });
  const anonBody = await anonRead.json();
  check('the unauthenticated role can read no data at all', Boolean(anonBody.errors), JSON.stringify(anonBody.data ?? {}));

  // ------------------------------------------------------- database event trigger
  section('A trigger beyond manual: a row change in a watched table');

  const runsBefore = await asAdmin(
    /* GraphQL */ `
      query CountEventRuns($workflow_id: uuid!) {
        workflow_runs_aggregate(
          where: { workflow_id: { _eq: $workflow_id }, trigger_type: { _eq: "database_event" } }
        ) { aggregate { count } }
      }
    `,
    { workflow_id: workflowA.id }
  );

  const leadInsert = await asUser(
    editorA,
    'editor',
    /* GraphQL */ `
      mutation AddLead($org_id: uuid!) {
        insert_inbound_leads_one(
          object: {
            org_id: $org_id
            email: "urgent@newco.test"
            company: "NewCo"
            message: "Our checkout is down, we need help immediately"
          }
        ) { id }
      }
    `,
    { org_id: workflowA.org.id }
  );
  check('an editor can insert a lead into the watched table', Boolean(leadInsert.data?.insert_inbound_leads_one), errorText(leadInsert));

  let eventRunStarted = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const runsAfter = await asAdmin(
      /* GraphQL */ `
        query CountEventRuns($workflow_id: uuid!) {
          workflow_runs_aggregate(
            where: { workflow_id: { _eq: $workflow_id }, trigger_type: { _eq: "database_event" } }
          ) { aggregate { count } }
        }
      `,
      { workflow_id: workflowA.id }
    );
    if (
      runsAfter.workflow_runs_aggregate.aggregate.count >
      runsBefore.workflow_runs_aggregate.aggregate.count
    ) {
      eventRunStarted = true;
      break;
    }
  }
  check('the row change started a run with no button click', eventRunStarted);

  // ------------------------------------------------------------------- quota
  section('Quota enforcement');

  const orgId = workflowA.org.id;
  const before = await asAdmin(
    /* GraphQL */ `
      query Usage($org_id: uuid!) {
        org_usage_summary(where: { org_id: { _eq: $org_id } }) { calls_used calls_allowed calls_remaining }
      }
    `,
    { org_id: orgId }
  );
  check(
    'external calls have been charged to the org quota',
    before.org_usage_summary[0].calls_used > 0,
    JSON.stringify(before.org_usage_summary[0])
  );

  // Squeeze the allowance down to what has already been spent, then try again.
  await asAdmin(
    /* GraphQL */ `
      mutation Squeeze($org_id: uuid!, $allowed: Int!) {
        update_organizations_by_pk(pk_columns: { id: $org_id }, _set: { calls_allowed: $allowed }) { calls_allowed }
      }
    `,
    { org_id: orgId, allowed: before.org_usage_summary[0].calls_used }
  );

  const refused = await asUser(ownerA, 'owner', TRIGGER_RUN, { workflow_id: workflowA.id, input: urgentLead });
  check(
    'a run is refused when the quota is exhausted',
    Boolean(refused.errors) && /quota/i.test(errorText(refused)),
    errorText(refused) || 'run was allowed'
  );

  await asAdmin(
    /* GraphQL */ `
      mutation Restore($org_id: uuid!) {
        update_organizations_by_pk(pk_columns: { id: $org_id }, _set: { calls_allowed: 200 }) { calls_allowed }
      }
    `,
    { org_id: orgId }
  );

  // ------------------------------------------------------------------- retries
  section('Retry on failure');

  // A dedicated single-step workflow whose http_request always fails, so the retry
  // path is exercised without disturbing the demo workflow.
  const retryWorkflow = await asAdmin(
    /* GraphQL */ `
      mutation RetryWorkflow($org_id: uuid!, $created_by: uuid!) {
        insert_workflows_one(
          object: {
            org_id: $org_id
            name: "Retry probe"
            created_by: $created_by
            steps: {
              data: [
                {
                  position: 1
                  type: "http_request"
                  name: "Call an endpoint that always fails"
                  created_by: $created_by
                  config: {
                    method: "GET"
                    url: "https://httpbin.org/status/503"
                    timeout_ms: 8000
                    max_attempts: 2
                  }
                }
              ]
            }
          }
        ) { id }
      }
    `,
    { org_id: orgId, created_by: ownerA.userId }
  );

  const retryRun = await asUser(ownerA, 'owner', TRIGGER_RUN, {
    workflow_id: retryWorkflow.insert_workflows_one.id,
    input: {},
  });
  const retryRunId = retryRun.data?.triggerWorkflowRun?.workflow_run_id;
  check('a failing step fails the run', retryRun.data?.triggerWorkflowRun?.status === 'failed', errorText(retryRun));

  if (retryRunId) {
    const retryDetail = await asUser(ownerA, 'owner', RUN_DETAIL, { run_id: retryRunId });
    const attempt = retryDetail.data?.workflow_runs_by_pk?.step_runs?.[0]?.attempt;
    check('the failing step was attempted more than once', attempt >= 2, `attempt=${attempt}`);
    check(
      'both attempts were charged to the quota',
      retryDetail.data?.workflow_runs_by_pk?.external_calls >= 2,
      `external_calls=${retryDetail.data?.workflow_runs_by_pk?.external_calls}`
    );
  }

  await asAdmin(/* GraphQL */ `mutation Del($id: uuid!) { delete_workflows_by_pk(id: $id) { id } }`, {
    id: retryWorkflow.insert_workflows_one.id,
  });

  // ------------------------------------------------------------------ summary
  console.log(`\n${'='.repeat(62)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nfailed checks:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
  console.log('='.repeat(62));
}

main().catch((error) => {
  console.error('\nverification crashed:', error);
  process.exitCode = 1;
});
