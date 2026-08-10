// Every GraphQL document the app uses, in one place.

export const ORG_WORKFLOWS = /* GraphQL */ `
  query OrgWorkflows($org_id: uuid!) {
    workflows(where: { org_id: { _eq: $org_id } }, order_by: { created_at: asc }) {
      id
      name
      description
      is_active
      updated_at
      steps_aggregate {
        aggregate {
          count
        }
      }
      triggers {
        id
        type
        is_enabled
      }
      # "Most recent run status" for the list, straight from the relationship.
      runs(order_by: { created_at: desc }, limit: 1) {
        id
        status
        trigger_type
        created_at
        duration_seconds
      }
    }
  }
`;

export const WORKFLOW_DETAIL = /* GraphQL */ `
  query WorkflowDetail($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      org_id
      name
      description
      is_active
      author {
        email
      }
      steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
        step_type {
          requires_owner
          comment
        }
      }
      triggers(order_by: { type: asc }) {
        id
        type
        config
        is_enabled
        trigger_type {
          requires_owner
          comment
        }
      }
      runs(order_by: { created_at: desc }, limit: 8) {
        id
        status
        trigger_type
        created_at
        duration_seconds
        initiator {
          email
        }
      }
    }
    step_types(order_by: { value: asc }) {
      value
      comment
      requires_owner
    }
    trigger_types(order_by: { value: asc }) {
      value
      comment
      requires_owner
    }
  }
`;

/** Owners additionally get the webhook token; editors have no such column. */
export const WEBHOOK_TOKEN = /* GraphQL */ `
  query WebhookToken($workflow_id: uuid!) {
    workflow_triggers(where: { workflow_id: { _eq: $workflow_id }, type: { _eq: "webhook" } }) {
      id
      webhook_token
    }
  }
`;

export const USAGE_SUBSCRIPTION = /* GraphQL */ `
  subscription Usage($org_id: uuid!) {
    org_usage_summary(where: { org_id: { _eq: $org_id } }) {
      calls_used
      calls_allowed
      calls_remaining
      period_start
      runs_this_period
      paused_runs
      avg_run_duration_seconds
    }
  }
`;

/** The required subscription: step_runs filtered to one workflow_run_id. */
export const STEP_RUNS_SUBSCRIPTION = /* GraphQL */ `
  subscription WatchSteps($run_id: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $run_id } }, order_by: { position: asc }) {
      id
      position
      step_name
      step_type
      status
      attempt
      error
      input
      output
      started_at
      finished_at
      approved_at
      approval_note
      approver {
        email
        role
      }
    }
  }
`;

export const RUN_SUBSCRIPTION = /* GraphQL */ `
  subscription WatchRun($run_id: uuid!) {
    workflow_runs_by_pk(id: $run_id) {
      id
      status
      trigger_type
      error
      external_calls
      duration_seconds
      created_at
      finished_at
      resume_from_position
      workflow {
        id
        name
      }
      initiator {
        email
      }
    }
  }
`;

export const RUN_SIDE_EFFECTS = /* GraphQL */ `
  query RunSideEffects($run_id: uuid!) {
    workflow_artifacts(where: { workflow_run_id: { _eq: $run_id } }, order_by: { created_at: asc }) {
      id
      key
      payload
    }
    notifications(where: { workflow_run_id: { _eq: $run_id } }, order_by: { created_at: asc }) {
      id
      channel
      target
      status
      error
    }
  }
`;

// --- mutations ---------------------------------------------------------------
export const TRIGGER_RUN = /* GraphQL */ `
  mutation TriggerRun($workflow_id: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $workflow_id, input: $input) {
      workflow_run_id
      status
      steps_executed
      message
    }
  }
`;

export const APPROVE_STEP = /* GraphQL */ `
  mutation ApproveStep($step_run_id: uuid!, $decision: ApprovalDecision!, $note: String) {
    approveStep(step_run_id: $step_run_id, decision: $decision, note: $note) {
      step_run_id
      run_status
      resumed
      message
    }
  }
`;

export const CREATE_WORKFLOW = /* GraphQL */ `
  mutation CreateWorkflow($org_id: uuid!, $name: String!, $description: String) {
    insert_workflows_one(object: { org_id: $org_id, name: $name, description: $description }) {
      id
    }
  }
`;

export const UPDATE_WORKFLOW = /* GraphQL */ `
  mutation UpdateWorkflow($id: uuid!, $set: workflows_set_input!) {
    update_workflows_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      name
      description
      is_active
    }
  }
`;

export const ADD_STEP = /* GraphQL */ `
  mutation AddStep($workflow_id: uuid!, $position: Int!, $type: String!, $name: String!, $config: jsonb!) {
    insert_workflow_steps_one(
      object: { workflow_id: $workflow_id, position: $position, type: $type, name: $name, config: $config }
    ) {
      id
    }
  }
`;

export const UPDATE_STEP = /* GraphQL */ `
  mutation UpdateStep($id: uuid!, $set: workflow_steps_set_input!) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
    }
  }
`;

export const DELETE_STEP = /* GraphQL */ `
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) {
      id
    }
  }
`;

/**
 * Reorder is two position updates in a single mutation, which Hasura runs in one
 * transaction. The unique constraint on (workflow_id, position) is DEFERRABLE, so
 * the intermediate state where both rows would collide is never checked.
 */
export const SWAP_STEP_POSITIONS = /* GraphQL */ `
  mutation SwapStepPositions($a_id: uuid!, $a_position: Int!, $b_id: uuid!, $b_position: Int!) {
    a: update_workflow_steps_by_pk(pk_columns: { id: $a_id }, _set: { position: $a_position }) {
      id
      position
    }
    b: update_workflow_steps_by_pk(pk_columns: { id: $b_id }, _set: { position: $b_position }) {
      id
      position
    }
  }
`;

export const ADD_TRIGGER = /* GraphQL */ `
  mutation AddTrigger($workflow_id: uuid!, $type: String!, $config: jsonb!) {
    insert_workflow_triggers_one(object: { workflow_id: $workflow_id, type: $type, config: $config }) {
      id
    }
  }
`;

export const SET_TRIGGER_ENABLED = /* GraphQL */ `
  mutation SetTriggerEnabled($id: uuid!, $is_enabled: Boolean!) {
    update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: { is_enabled: $is_enabled }) {
      id
      is_enabled
    }
  }
`;

export const DELETE_TRIGGER = /* GraphQL */ `
  mutation DeleteTrigger($id: uuid!) {
    delete_workflow_triggers_by_pk(id: $id) {
      id
    }
  }
`;

export const ADD_LEAD = /* GraphQL */ `
  mutation AddLead($org_id: uuid!, $email: String!, $company: String, $message: String) {
    insert_inbound_leads_one(
      object: { org_id: $org_id, email: $email, company: $company, message: $message }
    ) {
      id
    }
  }
`;
