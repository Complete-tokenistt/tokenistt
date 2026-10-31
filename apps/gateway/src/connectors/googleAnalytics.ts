import type { Connector, ConnectorContext, Entity } from './types.js';
import { httpJson, requireConfig } from './http.js';

/**
 * Google Analytics 4 (Data API). Pages/screens become `feature` entities with their
 * session counts, so AI cost can be compared with product usage.
 *
 * config: { propertyId, accessToken }  or  { propertyId, clientId, clientSecret, refreshToken }
 *         optional: dataApiBase, tokenUrl, days (default 30), limit (default 100)
 */
const dataBase = (c: Record<string, any>) => (c.dataApiBase || 'https://analyticsdata.googleapis.com').replace(/\/+$/, '');

async function accessToken(c: Record<string, any>): Promise<string> {
  if (c.accessToken) return c.accessToken;
  requireConfig(c, 'clientId', 'clientSecret', 'refreshToken');
  const res = await httpJson<{ access_token: string }>(c.tokenUrl || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    // token endpoint takes form encoding; JSON is accepted by Google's OAuth2 server
    body: { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' },
  });
  return res.access_token;
}

async function report(c: Record<string, any>, token: string, limit: number) {
  const days = Number(c.days) > 0 ? Number(c.days) : 30;
  return httpJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
    `${dataBase(c)}/v1beta/properties/${encodeURIComponent(c.propertyId)}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit,
      },
    }
  );
}

export const googleAnalytics: Connector = {
  type: 'google-analytics',
  label: 'Google Analytics 4',
  configFields: [
    { key: 'propertyId', required: true, description: 'GA4 property id (numbers only)' },
    { key: 'accessToken', required: false, secret: true, description: 'OAuth access token (or provide the refresh-token trio below)' },
    { key: 'clientId', required: false, description: 'OAuth client id' },
    { key: 'clientSecret', required: false, secret: true, description: 'OAuth client secret' },
    { key: 'refreshToken', required: false, secret: true, description: 'OAuth refresh token' },
    { key: 'days', required: false, description: 'Look-back window in days (default 30)' },
  ],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'propertyId');
    await report(config, await accessToken(config), 1);
  },

  async sync({ config }: ConnectorContext): Promise<Entity[]> {
    requireConfig(config, 'propertyId');
    const limit = Number(config.limit) > 0 ? Number(config.limit) : 100;
    const res = await report(config, await accessToken(config), limit);
    return (res.rows ?? []).map(r => ({
      dimension: 'feature' as const,
      externalId: r.dimensionValues[0].value,
      name: r.dimensionValues[0].value,
      data: { sessions: Number(r.metricValues[0].value), activeUsers: Number(r.metricValues[1].value) },
    }));
  },
};
