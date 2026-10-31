import type { Connector, ConnectorContext, Entity } from './types.js';
import { httpJson, paginate, requireConfig } from './http.js';

/** config: { token, org?, apiBase? }  — org omitted => repos the token owner can access. */
const base = (c: Record<string, any>) => (c.apiBase || 'https://api.github.com').replace(/\/+$/, '');
const headers = (c: Record<string, any>) => ({
  Authorization: `Bearer ${c.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'tokenistt-connector',
});

/** Follow GitHub's `Link: <...>; rel="next"` pagination without an extra helper request. */
async function list(url: string, c: Record<string, any>): Promise<any[]> {
  return paginate<any>(url, async u => {
    const items = await httpJson<any[]>(u, { headers: headers(c) });
    // httpJson hides response headers; use per_page + page counter instead of Link parsing.
    const m = /[?&]page=(\d+)/.exec(u);
    const page = m ? Number(m[1]) : 1;
    return { items, next: items.length === 100 ? u.replace(/([?&])page=\d+/, `$1page=${page + 1}`) : null };
  });
}

export const github: Connector = {
  type: 'github',
  label: 'GitHub',
  configFields: [
    { key: 'token', required: true, secret: true, description: 'Fine-grained PAT or GitHub App token (read: metadata, members)' },
    { key: 'org', required: false, description: 'Organization login; omit for the token owner’s repositories' },
    { key: 'apiBase', required: false, description: 'GitHub Enterprise API base URL' },
  ],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'token');
    await httpJson(`${base(config)}/user`, { headers: headers(config) });
  },

  async sync({ config }: ConnectorContext): Promise<Entity[]> {
    requireConfig(config, 'token');
    const repoUrl = config.org
      ? `${base(config)}/orgs/${encodeURIComponent(config.org)}/repos?per_page=100&page=1`
      : `${base(config)}/user/repos?per_page=100&page=1`;
    const repos = await list(repoUrl, config);
    const out: Entity[] = repos.map(r => ({
      dimension: 'repo',
      externalId: r.full_name,
      name: r.full_name,
      data: { private: r.private, language: r.language, archived: r.archived, url: r.html_url },
    }));

    if (config.org) {
      const members = await list(`${base(config)}/orgs/${encodeURIComponent(config.org)}/members?per_page=100&page=1`, config);
      out.push(...members.map(m => ({ dimension: 'employee' as const, externalId: m.login, name: m.login, data: { url: m.html_url } })));
    }
    return out;
  },
};
