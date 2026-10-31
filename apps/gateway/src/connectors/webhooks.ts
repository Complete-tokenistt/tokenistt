import type { Connector, ConnectorContext, Entity, WebhookRequest } from './types.js';
import { ConnectorError } from './types.js';
import { requireConfig, verifyHmac } from './http.js';

const DIMENSIONS = new Set(['repo', 'ticket', 'sprint', 'feature', 'customer', 'employee', 'deployment', 'channel']);
const clip = (v: unknown, n = 200) => (v === undefined || v === null ? undefined : String(v).slice(0, n));

/**
 * Custom inbound webhook. POST JSON `{ "entities": [{ dimension, external_id, name?, data? }] }`
 * signed with `X-Tokenistt-Signature: sha256=<hmac of the raw body>` using the connector secret.
 * config: { secret }
 */
export const customWebhook: Connector = {
  type: 'webhook',
  label: 'Custom webhook',
  configFields: [{ key: 'secret', required: true, secret: true, description: 'Shared secret used to sign payloads (HMAC-SHA256)' }],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'secret');
  },

  async webhook({ config }: ConnectorContext, req: WebhookRequest): Promise<Entity[]> {
    requireConfig(config, 'secret');
    if (!verifyHmac(config.secret, req.rawBody, req.headers['x-tokenistt-signature'])) {
      throw new ConnectorError('Invalid signature.', 401);
    }
    const items = Array.isArray(req.body?.entities) ? req.body.entities : [];
    if (items.length === 0 || items.length > 500) throw new ConnectorError('Send between 1 and 500 entities.');
    return items.map((e: any, i: number): Entity => {
      if (!DIMENSIONS.has(e?.dimension)) throw new ConnectorError(`entities[${i}].dimension is invalid.`);
      if (!e.external_id) throw new ConnectorError(`entities[${i}].external_id is required.`);
      return { dimension: e.dimension, externalId: clip(e.external_id)!, name: clip(e.name), data: typeof e.data === 'object' && e.data ? e.data : {} };
    });
  },
};

/**
 * CI/CD deployments. Accepts GitHub Actions `workflow_run`, GitLab `pipeline`/`deployment`
 * and a generic `{ deployment: { id, name, status, ref } }` payload, normalised to `deployment` entities.
 * Authenticity: GitHub `X-Hub-Signature-256`, GitLab `X-Gitlab-Token`, or `X-Tokenistt-Signature`.
 * config: { secret }
 */
export const cicd: Connector = {
  type: 'cicd',
  label: 'CI/CD deployments',
  configFields: [{ key: 'secret', required: true, secret: true, description: 'Webhook secret configured in GitHub/GitLab/your pipeline' }],

  async authenticate({ config }: ConnectorContext) {
    requireConfig(config, 'secret');
  },

  async webhook({ config }: ConnectorContext, req: WebhookRequest): Promise<Entity[]> {
    requireConfig(config, 'secret');
    const h = req.headers;
    const gitlabOk = h['x-gitlab-token'] !== undefined && h['x-gitlab-token'] === config.secret;
    const hmacOk = verifyHmac(config.secret, req.rawBody, h['x-hub-signature-256'] ?? h['x-tokenistt-signature']);
    if (!gitlabOk && !hmacOk) throw new ConnectorError('Invalid signature.', 401);

    const b = req.body ?? {};
    if (b.workflow_run) {
      const r = b.workflow_run;
      return [{
        dimension: 'deployment', externalId: String(r.id), name: clip(r.name),
        data: { status: r.conclusion ?? r.status, branch: r.head_branch, sha: r.head_sha, repo: b.repository?.full_name, url: r.html_url },
      }];
    }
    if (b.object_kind === 'pipeline' || b.object_kind === 'deployment') {
      const id = b.object_attributes?.id ?? b.deployment_id;
      if (!id) throw new ConnectorError('GitLab payload has no pipeline/deployment id.');
      return [{
        dimension: 'deployment', externalId: String(id), name: clip(b.project?.path_with_namespace),
        data: { status: b.object_attributes?.status ?? b.status, ref: b.object_attributes?.ref ?? b.ref, sha: b.object_attributes?.sha },
      }];
    }
    if (b.deployment?.id) {
      return [{ dimension: 'deployment', externalId: String(b.deployment.id), name: clip(b.deployment.name), data: { status: b.deployment.status, ref: b.deployment.ref } }];
    }
    throw new ConnectorError('Unrecognised CI/CD payload.');
  },
};
