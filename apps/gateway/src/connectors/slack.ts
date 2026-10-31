import type { Connector, ConnectorContext, Entity } from './types.js';
import { httpJson, requireConfig } from './http.js';

/** config: { botToken, apiBase? } — bot scopes: users:read, channels:read (and chat:write to deliver alerts). */
const base = (c: Record<string, any>) => (c.apiBase || 'https://slack.com/api').replace(/\/+$/, '');
const headers = (c: Record<string, any>) => ({ Authorization: `Bearer ${c.botToken}` });

async function slack<T = any>(c: Record<string, any>, method: string, body?: unknown): Promise<T> {
  const res = await httpJson<any>(`${base(c)}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: headers(c),
    body,
  });
  // Slack answers 200 with { ok: false, error } for API-level failures.
  if (!res.ok) throw new Error(`Slack ${method} failed: ${res.error ?? 'unknown_error'}`);
  return res as T;
}

export const slackConnector: Connector = {
  type: 'slack',
  label: 'Slack',
  configFields: [
    { key: 'botToken', required: true, secret: true, description: 'Bot token (xoxb-…)' },
    { key: 'alertChannel', required: false, description: 'Channel id to post budget/approval alerts to' },
  ],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'botToken');
    await slack(config, 'auth.test');
  },

  async sync({ config }: ConnectorContext): Promise<Entity[]> {
    requireConfig(config, 'botToken');
    const out: Entity[] = [];

    const users = await slack<{ members: any[] }>(config, 'users.list?limit=200');
    for (const u of users.members ?? []) {
      if (u.deleted || u.is_bot) continue;
      out.push({
        dimension: 'employee',
        externalId: u.profile?.email || u.id,
        name: u.real_name || u.name,
        data: { slackId: u.id, title: u.profile?.title ?? null },
      });
    }

    const chans = await slack<{ channels: any[] }>(config, 'conversations.list?limit=200&exclude_archived=true');
    for (const c of chans.channels ?? []) {
      out.push({ dimension: 'channel', externalId: c.id, name: c.name, data: { isPrivate: !!c.is_private, members: c.num_members } });
    }
    return out;
  },
};

/** Deliver a text alert to the configured channel (used by notify when a Slack connector exists). */
export async function postSlackMessage(config: Record<string, any>, text: string): Promise<void> {
  requireConfig(config, 'botToken', 'alertChannel');
  await slack(config, 'chat.postMessage', { channel: config.alertChannel, text });
}
