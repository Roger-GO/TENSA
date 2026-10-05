/**
 * The topology schema the add and edit forms and the data grids read, as
 * `GET /topology/schema` returns it (the server's `_PARAMS_BY_MODEL`), so a test
 * of a table works on the parameters the models really have.
 *
 * The response is the JSON beside this file. A server test
 * (`server/tests/unit/test_topology_schema_fixture.py`) fails when the two differ,
 * and says how to write the file again.
 */
import type { TopologySchema } from '@/api/types';
import schema from './topologySchema.json';

export const TOPOLOGY_SCHEMA = schema as TopologySchema;
