import type { Connector, ConnectorContext, Entity } from './types.js';
import { httpJson, requireConfig } from './http.js';

/** config: { apiKey, apiBase? } — Linear personal API key (sent as-is, no Bearer prefix). */
const endpoint = (c: Record<string, any>) => (c.apiBase || 'https://api.linear.app/graphql');

async function gql<T>(c: Record<string, any>, query: string): Promise<T> {
  const res = await httpJson<{ data?: T; errors?: { message: string }[] }>(endpoint(c), {
    method: 'POST',
    headers: { Authorization: c.apiKey },
    body: { query },
  });
  if (res.errors?.length) throw new Error(`Linear: ${res.errors[0].message}`);
  return res.data as T;
}

export const linear: Connector = {
  type: 'linear',
  label: 'Linear',
  configFields: [{ key: 'apiKey', required: true, secret: true, description: 'Linear API key' }],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'apiKey');
    await gql(config, '{ viewer { id } }');
  },

  async sync({ config }: ConnectorContext): Promise<Entity[]> {
    requireConfig(config, 'apiKey');
    const data = await gql<{
      issues: { nodes: { identifier: string; title: string; state?: { name: string }; team?: { key: string }; assignee?: { email: string } }[] };
      cycles: { nodes: { id: string; number: number; name?: string; startsAt?: string; endsAt?: string; team?: { key: string } }[] };
    }>(
      config,
      `{ issues(first: 100, orderBy: updatedAt) { nodes { identifier title state { name } team { key } assignee { email } } }
         cycles(first: 50) { nodes { id number name startsAt endsAt team { key } } } }`
    );

    const out: Entity[] = [];
    for (const i of data.issues?.nodes ?? []) {
      out.push({ dimension: 'ticket', externalId: i.identifier, name: i.title, data: { state: i.state?.name, team: i.team?.key, assignee: i.assignee?.email ?? null } });
    }
    for (const c of data.cycles?.nodes ?? []) {
      out.push({ dimension: 'sprint', externalId: c.id, name: c.name || `Cycle ${c.number}`, data: { number: c.number, startsAt: c.startsAt, endsAt: c.endsAt, team: c.team?.key } });
    }
    return out;
  },
};
