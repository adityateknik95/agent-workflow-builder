// Hasura Event Trigger handler: a `notify` step enqueued a notification.
//
// This is what makes `notify` an Event Trigger step rather than an inline HTTP
// call: the executor writes a row and moves on, and delivery happens here with
// Hasura's own retry budget. The run's timing never depends on how slow Slack is.
import { adminGraphql } from '../_lib/gql';
import { assertFromHasura, fetchWithTimeout, respondWithError } from '../_lib/http';
import { config } from '../_lib/config';
import type { FnRequest, FnResponse } from '../_lib/types';

interface NotificationRow {
  id: string;
  channel: 'slack' | 'email';
  target: string | null;
  subject: string | null;
  body: string;
  attempt: number;
}

interface EventPayload {
  event: { op: string; data: { new: NotificationRow | null } };
  trigger: { name: string };
}

const MARK_NOTIFICATION = /* GraphQL */ `
  mutation MarkNotification($id: uuid!, $set: notifications_set_input!) {
    update_notifications_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      status
    }
  }
`;

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  try {
    assertFromHasura(req);

    const body = req.body as EventPayload;
    const notification = body.event?.data?.new;

    if (!notification) {
      res.status(200).json({ delivered: false, reason: 'event carried no notification row' });
      return;
    }

    const attempt = (notification.attempt ?? 0) + 1;

    // Nothing to deliver to. Recorded as `skipped` rather than `sent`, so the UI
    // never claims a message went out when no channel was configured.
    if (notification.channel === 'slack' && !config.slackWebhookUrl) {
      await adminGraphql(MARK_NOTIFICATION, {
        id: notification.id,
        set: {
          status: 'skipped',
          attempt,
          error: 'SLACK_WEBHOOK_URL is not configured; the message was recorded but not delivered',
        },
      });
      res.status(200).json({ delivered: false, reason: 'no slack webhook configured' });
      return;
    }

    if (notification.channel === 'email') {
      await adminGraphql(MARK_NOTIFICATION, {
        id: notification.id,
        set: {
          status: 'skipped',
          attempt,
          error: 'email delivery is not wired up in this deployment; the message was recorded only',
        },
      });
      res.status(200).json({ delivered: false, reason: 'email transport not configured' });
      return;
    }

    const text = [notification.subject, notification.body].filter(Boolean).join('\n');

    try {
      const response = await fetchWithTimeout(
        config.slackWebhookUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            ...(notification.target ? { channel: notification.target } : {}),
          }),
        },
        10_000
      );

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`slack returned ${response.status}: ${detail}`);
      }

      await adminGraphql(MARK_NOTIFICATION, {
        id: notification.id,
        set: { status: 'sent', attempt, delivered_at: new Date().toISOString(), error: null },
      });
      res.status(200).json({ delivered: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'delivery failed';
      await adminGraphql(MARK_NOTIFICATION, {
        id: notification.id,
        set: { status: 'failed', attempt, error: message },
      });

      // Non-2xx here asks Hasura to retry according to the trigger's retry_conf.
      res.status(502).json({ delivered: false, error: message });
    }
  } catch (error) {
    respondWithError(res, error);
  }
}
