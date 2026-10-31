import type { Connector, ConnectorContext, Entity } from './types.js';
import { httpJson, requireConfig } from './http.js';

/** config: { baseUrl, email, apiToken, jql?, boardId? } — Jira Cloud (Basic auth with API token). */
const root = (c: Record<string, any>) => String(c.baseUrl).replace(/\/+$/, '');
const headers = (c: Record<string, any>) => ({
  Authorization: `Basic ${Buffer.from(`${c.email}:${c.apiToken}`).toString('base64')}`,
});

export const jira: Connector = {
  type: 'jira',
  label: 'Jira',
  configFields: [
    { key: 'baseUrl', required: true, description: 'https://your-site.atlassian.net' },
    { key: 'email', required: true, description: 'Account email for the API token' },
    { key: 'apiToken', required: true, secret: true, description: 'Atlassian API token' },
    { key: 'jql', required: false, description: 'Issues to sync (default: updated in the last 30 days)' },
    { key: 'boardId', required: false, description: 'Agile board id, to also sync its sprints' },
  ],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'baseUrl', 'email', 'apiToken');
    await httpJson(`${root(config)}/rest/api/3/myself`, { headers: headers(config) });
  },

  async sync({ config }: ConnectorContext): Promise<Entity[]> {
    requireConfig(config, 'baseUrl', 'email', 'apiToken');
    const jql = config.jql || 'updated >= -30d ORDER BY updated DESC';
    const out: Entity[] = [];

    const res = await httpJson<{ issues: any[] }>(
      `${root(config)}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,status,assignee,project`,
      { headers: headers(config) }
    );
    for (const i of res.issues ?? []) {
      out.push({
        dimension: 'ticket',
        externalId: i.key,
        name: i.fields?.summary,
        data: { status: i.fields?.status?.name, project: i.fields?.project?.key, assignee: i.fields?.assignee?.emailAddress ?? null },
      });
    }

    if (config.boardId) {
      const sprints = await httpJson<{ values: any[] }>(
        `${root(config)}/rest/agile/1.0/board/${encodeURIComponent(config.boardId)}/sprint?maxResults=50`,
        { headers: headers(config) }
      );
      for (const s of sprints.values ?? []) {
        out.push({
          dimension: 'sprint',
          externalId: String(s.id),
          name: s.name,
          data: { state: s.state, startDate: s.startDate, endDate: s.endDate },
        });
      }
    }
    return out;
  },
};
