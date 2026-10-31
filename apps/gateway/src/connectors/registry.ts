import type { Connector } from './types.js';
import { github } from './github.js';
import { jira } from './jira.js';
import { slackConnector } from './slack.js';
import { linear } from './linear.js';
import { googleAnalytics } from './googleAnalytics.js';
import { salesforce } from './salesforce.js';
import { cicd, customWebhook } from './webhooks.js';

const ALL: Connector[] = [github, jira, slackConnector, linear, googleAnalytics, salesforce, cicd, customWebhook];
const byType = new Map(ALL.map(c => [c.type, c]));

export const getConnector = (type: string): Connector | undefined => byType.get(type);

/** Public catalogue (field descriptions only — no secrets). */
export const listConnectorTypes = () =>
  ALL.map(c => ({
    type: c.type,
    label: c.label,
    mode: [c.sync ? 'pull' : null, c.webhook ? 'webhook' : null].filter(Boolean),
    fields: c.configFields,
  }));

export type { Connector, Entity, Dimension, ConnectorContext, WebhookRequest } from './types.js';
export { ConnectorError } from './types.js';
