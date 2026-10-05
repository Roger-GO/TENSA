/**
 * Renders a data grid inside a query client that already holds the topology
 * schema, so a table's editing (which reads the schema and sends writes through
 * the query hooks) mounts the way it does in the app, with no request for the
 * schema going out.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '@/api/queries';
import { TOPOLOGY_SCHEMA } from './topologySchema';

export function makeGridQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(queryKeys.topologySchema, TOPOLOGY_SCHEMA);
  return client;
}

/** `render` with a query client holding the schema; `client` is returned to seed or read it. */
export function renderWithQuery(ui: ReactElement, client: QueryClient = makeGridQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Object.assign(render(ui, { wrapper }), { client });
}
