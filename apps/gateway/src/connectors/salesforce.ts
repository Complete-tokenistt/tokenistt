import type { Connector, ConnectorContext, Entity } from './types.js';
import { httpJson, requireConfig } from './http.js';

/**
 * Salesforce (REST). Accounts become `customer` entities, enabling cost-per-customer.
 * config: { instanceUrl, accessToken, apiVersion?, soql? }
 */
const root = (c: Record<string, any>) => String(c.instanceUrl).replace(/\/+$/, '');
const version = (c: Record<string, any>) => (c.apiVersion || 'v59.0');
const headers = (c: Record<string, any>) => ({ Authorization: `Bearer ${c.accessToken}` });

export const salesforce: Connector = {
  type: 'salesforce',
  label: 'Salesforce',
  configFields: [
    { key: 'instanceUrl', required: true, description: 'https://yourorg.my.salesforce.com' },
    { key: 'accessToken', required: true, secret: true, description: 'OAuth access token (api scope)' },
    { key: 'soql', required: false, description: 'Custom SOQL returning Id, Name (default: all Accounts)' },
  ],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'instanceUrl', 'accessToken');
    await httpJson(`${root(config)}/services/data/${version(config)}/limits`, { headers: headers(config) });
  },

  async sync({ config }: ConnectorContext): Promise<Entity[]> {
    requireConfig(config, 'instanceUrl', 'accessToken');
    const soql = config.soql || 'SELECT Id, Name, Industry, AnnualRevenue FROM Account ORDER BY LastModifiedDate DESC LIMIT 200';
    const out: Entity[] = [];
    let url: string | null = `${root(config)}/services/data/${version(config)}/query?q=${encodeURIComponent(soql)}`;

    for (let page = 0; url && page < 10; page++) {
      const res: { records: any[]; nextRecordsUrl?: string } = await httpJson(url, { headers: headers(config) });
      for (const r of res.records ?? []) {
        out.push({ dimension: 'customer', externalId: r.Id, name: r.Name, data: { industry: r.Industry ?? null, annualRevenue: r.AnnualRevenue ?? null } });
      }
      url = res.nextRecordsUrl ? `${root(config)}${res.nextRecordsUrl}` : null;
    }
    return out;
  },
};
