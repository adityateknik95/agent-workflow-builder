'use client';

import { createClient, withClientSideSessionMiddleware, type NhostClient } from '@nhost/nhost-js';

export const AUTH_URL = process.env.NEXT_PUBLIC_NHOST_AUTH_URL ?? 'http://localhost:4000/v1';
export const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL ?? 'http://localhost:8080/v1/graphql';
export const GRAPHQL_WS_URL =
  process.env.NEXT_PUBLIC_GRAPHQL_WS_URL ?? GRAPHQL_URL.replace(/^http/, 'ws');

let client: NhostClient | null = null;

/**
 * Single nhost client for the browser session.
 *
 * `withClientSideSessionMiddleware` is what keeps the access token attached to
 * outgoing requests and refreshes it before it expires -- the access token is
 * short lived, so a run that a user watches for several minutes keeps working.
 */
export function nhost(): NhostClient {
  if (!client) {
    client = createClient({
      authUrl: AUTH_URL,
      graphqlUrl: GRAPHQL_URL,
      configure: [withClientSideSessionMiddleware],
    });
  }
  return client;
}
