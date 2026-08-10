'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient as createWsClient, type Client as WsClient } from 'graphql-ws';
import { GRAPHQL_WS_URL, nhost } from './nhost';

/**
 * Every request carries `x-hasura-role`. That header only states which of the
 * caller's allowed roles they want to act as; whether they actually hold it in the
 * organisation that owns the rows is decided by the row permissions, so asking for
 * `owner` while being a viewer simply returns nothing.
 */
export async function request<TData>(
  query: string,
  variables: Record<string, unknown> = {},
  role?: string
): Promise<TData> {
  const response = await nhost().graphql.request<TData>(
    { query, variables },
    role ? { headers: { 'x-hasura-role': role } } : undefined
  );

  const body = response.body;
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join('; '));
  }
  if (!body.data) throw new Error('the server returned no data');
  return body.data;
}

export interface QueryState<TData> {
  data: TData | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

export function useQuery<TData>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { role?: string; skip?: boolean } = {}
): QueryState<TData> {
  const [data, setData] = useState<TData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!options.skip);
  const [nonce, setNonce] = useState(0);

  const key = JSON.stringify({ variables, role: options.role, skip: options.skip, nonce });

  useEffect(() => {
    if (options.skip) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);

    request<TData>(query, variables, options.role)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!active) return;
        setError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, key]);

  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, refetch };
}

// --- subscriptions -----------------------------------------------------------
let wsClient: WsClient | null = null;
let wsRole: string | undefined;

/**
 * graphql-ws client for Hasura live queries. Hasura authenticates the socket from
 * the connection_init payload, and the role travels with it, so the socket is
 * recreated when the active role changes.
 */
function socket(role?: string): WsClient {
  if (wsClient && wsRole === role) return wsClient;

  wsClient?.dispose();
  wsRole = role;
  wsClient = createWsClient({
    url: GRAPHQL_WS_URL,
    lazy: true,
    retryAttempts: Infinity,
    connectionParams: () => {
      const session = nhost().sessionStorage.get();
      return {
        headers: {
          ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
          ...(role ? { 'x-hasura-role': role } : {}),
        },
      };
    },
  });
  return wsClient;
}

export function useSubscription<TData>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { role?: string; skip?: boolean } = {}
): { data: TData | null; error: string | null } {
  const [data, setData] = useState<TData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const variablesKey = JSON.stringify(variables);
  const latest = useRef(variables);
  latest.current = variables;

  useEffect(() => {
    if (options.skip) return;

    const unsubscribe = socket(options.role).subscribe<TData>(
      { query, variables: latest.current },
      {
        next: (message) => {
          if (message.errors?.length) {
            setError(message.errors.map((e) => e.message).join('; '));
            return;
          }
          if (message.data) {
            setData(message.data);
            setError(null);
          }
        },
        error: (cause) => {
          setError(cause instanceof Error ? cause.message : 'the live connection failed');
        },
        complete: () => undefined,
      }
    );

    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, variablesKey, options.role, options.skip]);

  return { data, error };
}

export function disposeSocket(): void {
  wsClient?.dispose();
  wsClient = null;
  wsRole = undefined;
}
