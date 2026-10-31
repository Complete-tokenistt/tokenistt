/**
 * connectors/types.ts — connector framework.
 *
 * A connector pulls business context (repos, tickets, sprints, customers, people,
 * deployments, features) from another system so AI spend can be attributed to real work.
 * Entities are matched to spend by (dimension, external_id): a request sent with
 * `x-tokenistt-repo: acme/api` joins the `repo` entity `acme/api` synced from GitHub.
 */

export type Dimension =
  | 'repo' | 'ticket' | 'sprint' | 'feature' | 'customer' | 'employee' | 'deployment' | 'channel';

export interface Entity {
  dimension: Dimension;
  externalId: string;
  name?: string;
  data?: Record<string, unknown>;
}

export interface ConnectorContext {
  /** Decrypted connector configuration (tokens, base URLs, filters). */
  config: Record<string, any>;
  /** Only entities changed since this time need to be returned (best effort). */
  since?: Date;
}

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  body: any;
}

export interface Connector {
  readonly type: string;
  readonly label: string;
  /** JSON-ish description of required/optional config keys, for UIs and docs. */
  readonly configFields: { key: string; required: boolean; secret?: boolean; description: string }[];
  /** Cheap call proving the credentials work. Throws with a helpful message otherwise. */
  authenticate(ctx: ConnectorContext): Promise<void>;
  /** Pull entities from the remote system. Pull-based connectors implement this. */
  sync?(ctx: ConnectorContext): Promise<Entity[]>;
  /** Handle an inbound webhook (push-based connectors). Must verify the signature. */
  webhook?(ctx: ConnectorContext, req: WebhookRequest): Promise<Entity[]>;
}

export class ConnectorError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'ConnectorError';
  }
}
