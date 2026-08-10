// Authorisation checks the handlers perform themselves.
//
// This is the half of the permission story that database rules cannot cover. A
// Hasura Action permission proves which role the caller *asked* to act as; it
// does not prove they hold that role in the organisation that owns the row they
// named. And clearing an approval gate is a decision taken part way through an
// execution, not a row read or write, so there is no permission rule that could
// express it. Both of those are settled here, against org_members, before
// anything is written.
import { adminGraphql } from './gql';
import { HandlerError } from './http';
import type { OrgRole } from './types';

interface MembershipResult {
  org_members: { role: OrgRole }[];
}

const MEMBERSHIP_QUERY = /* GraphQL */ `
  query Membership($org_id: uuid!, $user_id: uuid!) {
    org_members(where: { org_id: { _eq: $org_id }, user_id: { _eq: $user_id } }, limit: 1) {
      role
    }
  }
`;

/** The caller's role in this org, or null if they are not a member of it. */
export async function roleInOrg(orgId: string, userId: string): Promise<OrgRole | null> {
  const data = await adminGraphql<MembershipResult>(MEMBERSHIP_QUERY, {
    org_id: orgId,
    user_id: userId,
  });
  return data.org_members[0]?.role ?? null;
}

/**
 * Asserts the caller holds one of `allowed` in this org.
 *
 * The failure is deliberately indistinguishable from "that workflow does not
 * exist": a caller from another org must not be able to tell, by comparing error
 * messages, whether an id they guessed is real.
 */
export async function requireRoleInOrg(
  orgId: string,
  userId: string | undefined,
  allowed: readonly OrgRole[],
  notFoundMessage: string
): Promise<OrgRole> {
  if (!userId) {
    throw new HandlerError('this operation requires an authenticated user', 'unauthenticated', 401);
  }

  const role = await roleInOrg(orgId, userId);
  if (!role || !allowed.includes(role)) {
    throw new HandlerError(notFoundMessage, 'not-found', 404);
  }
  return role;
}

/**
 * Second permission layer, execution-time half.
 *
 * `db_write` and `notify` steps reach outside the sandbox, and the database
 * permissions only let an owner author them. This re-checks, at the moment the
 * step actually runs, that whoever authored it still holds owner in the org --
 * so a step written while someone was an owner stops working once they are not,
 * and a step inserted through any path that bypassed the insert permission never
 * executes at all.
 */
export async function assertPrivilegedStepStillAuthorised(params: {
  orgId: string;
  stepType: string;
  stepName: string;
  authorId: string | null;
}): Promise<void> {
  const { orgId, stepType, stepName, authorId } = params;

  if (!authorId) {
    throw new HandlerError(
      `step "${stepName}" is a ${stepType} step with no recorded author, so it cannot be authorised`,
      'step-not-authorised',
      403
    );
  }

  const role = await roleInOrg(orgId, authorId);
  if (role !== 'owner') {
    throw new HandlerError(
      `step "${stepName}" is a ${stepType} step, which only an owner may run; its author is ` +
        `${role ? `now an ${role}` : 'no longer a member of this organisation'}`,
      'step-not-authorised',
      403
    );
  }
}
