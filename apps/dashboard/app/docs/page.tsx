import type { Metadata } from "next";
import "./docs.css";
import { Callout, Code, DocsFrame, Step } from "./docs-ui";

export const metadata: Metadata = {
  title: "Tokenistt · Documentation",
  description: "How Tokenistt works and how to set it up in your environment.",
};

const NAV: { group: string; items: [string, string][] }[] = [
  { group: "Start", items: [["overview", "Overview"], ["how-it-works", "How it works"], ["quickstart", "Quick start"]] },
  { group: "Setup", items: [["configuration", "Configuration"], ["auth", "Authentication & roles"], ["local-dev", "Local development"], ["production", "Production checklist"]] },
  { group: "Use", items: [["first-request", "Your first request"], ["sdk", "SDKs"], ["headers", "Request headers"], ["attribution", "Cost attribution"]] },
  { group: "Control", items: [["byok", "Provider keys (BYOK)"], ["budgets", "Budgets"], ["governance", "Policies & approvals"], ["routing", "Routing & failover"], ["alerts", "Alerts"], ["connectors", "Connectors"], ["audit", "Audit log"]] },
  { group: "Reference", items: [["admin-api", "Management API"], ["dashboard", "Dashboard pages"], ["mcp", "MCP server"], ["troubleshooting", "Troubleshooting"], ["limits", "Known gaps"]] },
];

const PIPELINE: [string, string, string][] = [
  ["01", "Auth", "Virtual key identifies the workspace"],
  ["02", "Policies", "Allow, block, force a model or hold for approval"],
  ["03", "Budgets", "Checked against each budget's own spend"],
  ["04", "Routing", "Cheapest, fastest or fallback target"],
  ["05", "BYOK key", "Highest-priority healthy provider key"],
  ["06", "Provider", "Streamed straight back to your app"],
  ["07", "Cost + log", "Priced and written async, fail-open"],
];

const FEATURES: [string, string][] = [
  ["Cost visibility", "Every request priced from a versioned catalog and attributed to a team, project, feature or repo."],
  ["Budgets", "Organization, team, project or key budgets in alert-only, auto-throttle or hard-cap mode."],
  ["Governance", "Policies that allow, block, force a model, or hold a request for human approval."],
  ["Routing", "Opt-in rules pick the cheapest or fastest target and fail over on provider errors."],
  ["BYOK", "Your provider keys, encrypted at rest, with priority and automatic fall-through."],
  ["Audit", "An append-only trail of admin actions and policy decisions."],
];

export default function DocsPage() {
  return (
    <DocsFrame nav={NAV}>
      <header className="docs-hero">
        <div className="docs-eyebrow mono"><b>Docs</b><i />Self-hosted · Apache-2.0</div>
        <h1>Understand it, then <em>set it up</em> in minutes.</h1>
        <p className="lead">
          Tokenistt is one OpenAI-compatible gateway in front of every AI provider you use, with spend tracking, budgets,
          policies and an audit trail. This guide explains how it works and how to run it in your environment.
        </p>
        <div className="docs-cards">
          <a className="docs-card" href="#quickstart"><div className="k mono">Start here</div><div className="t">Quick start</div><div className="d">Run the full stack with Docker Compose.</div></a>
          <a className="docs-card" href="#first-request"><div className="k mono">5 minutes</div><div className="t">First request</div><div className="d">Create a key and see cost on a real call.</div></a>
          <a className="docs-card" href="#configuration"><div className="k mono">Reference</div><div className="t">Configuration</div><div className="d">Every environment variable explained.</div></a>
          <a className="docs-card" href="#troubleshooting"><div className="k mono">Stuck?</div><div className="t">Troubleshooting</div><div className="d">Symptoms and fixes at a glance.</div></a>
        </div>
      </header>

      <main className="docs-main">
        <section>
        <h2 id="overview"><span className="num mono">01</span>Overview</h2>
        <p>
          Tokenistt is an open-source, self-hosted gateway that sits in front of the AI providers your team uses. It gives you
          cost visibility, budget enforcement, governance policies and cost-aware routing through a single integration: you change
          the base URL your apps call, and nothing else.
        </p>
        <div className="dgrid">
          {FEATURES.map(([t, d]) => (
            <div className="dfeat" key={t}><div className="t">{t}</div><div className="d">{d}</div></div>
          ))}
        </div>
        <p>Supported providers: OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Groq, Together AI, Google Gemini and Ollama. An offline <code>mock:</code> provider is available for testing without real keys.</p>
        </section>
        <section>
        <h2 id="how-it-works"><span className="num mono">02</span>How it works</h2>
        <p>Every request passes through one pipeline inside the gateway:</p>
        <div className="dpipe">
          {PIPELINE.map(([i, n, d]) => (
            <div className="dpipe-node" key={n}><div className="i mono">{i}</div><div className="n">{n}</div><div className="d">{d}</div></div>
          ))}
        </div>
        <p>Read it left to right: your app talks to the gateway, the gateway runs policies, budgets and routing, calls the provider with the right key, streams the answer back, then prices and logs the request in the background.</p>
        <Callout title="Fail-open by design">Event logging never blocks a request. If Postgres is down, events queue to disk and replay on recovery.
          Internal enforcement errors fail open — your production traffic keeps flowing unless you opted into hard enforcement.</Callout>
        <p>Unknown models report <code>COST_UNAVAILABLE</code> and <code>$0.00</code>. Prices are never invented, and are versioned so historical events keep the price that was true at the time.</p>
        </section>
        <section>
        <h2 id="quickstart"><span className="num mono">03</span>Quick start</h2>
        <p>The fastest way to run the whole stack is Docker Compose. You need Docker and about two minutes.</p>
        <Step n={1} title="Get the code and create your env file">
          <Code lang="bash">{`git clone https://github.com/Complete-tokenistt/tokenistt.git && cd tokenistt
cp .env.example .env`}</Code>
        </Step>
        <Step n={2} title="Fill in the five secrets">
          <p>Generate each one with <code>openssl rand -hex 32</code> and paste it into <code>.env</code>.</p>
          <Code lang="bash">{`# .env
POSTGRES_PASSWORD=
ADMIN_SECRET=
MASTER_KEY=
ENCRYPTION_KEY=
JWT_SECRET=`}</Code>
        </Step>
        <Step n={3} title="Start the stack">
          <Code lang="bash">{`docker compose up --build`}</Code>
          <p>Then open the services:</p>
          <div className="dtable-wrap"><table>
            <thead><tr><th>Service</th><th>URL</th></tr></thead>
            <tbody>
              <tr><td>Gateway (OpenAI-compatible API)</td><td><code>http://localhost:3000</code></td></tr>
              <tr><td>Dashboard and these docs</td><td><code>http://localhost:3001</code></td></tr>
              <tr><td>OpenAPI 3.1 document</td><td><code>http://localhost:3000/v1/openapi.json</code></td></tr>
            </tbody>
          </table></div>
        </Step>
        <p>Database migrations run automatically in a one-shot <code>migrate</code> container. Host ports are configurable with <code>GATEWAY_PORT</code>, <code>DASHBOARD_PORT</code>, <code>POSTGRES_PORT</code> and <code>REDIS_PORT</code>.</p>
        <p>Next: add a provider key (<a href="#byok">BYOK</a>), create a virtual key, and <a href="#first-request">send your first request</a>.</p>
        </section>
        <section>
        <h2 id="configuration"><span className="num mono">04</span>Configuration</h2>
        <p>Set these in <code>.env</code> (Docker Compose) or as environment variables.</p>
        <div className="dtable-wrap"><table>
          <thead><tr><th>Variable</th><th>Needed</th><th>Purpose</th></tr></thead>
          <tbody>
            <tr><td><code>DATABASE_URL</code></td><td>yes</td><td>Postgres connection. If unset, the gateway runs in open mode for local experiments (no auth, no logging).</td></tr>
            <tr><td><code>REDIS_URL</code></td><td>recommended</td><td>Shared rate limits and atomic budget reservation. <code>REDIS_REQUIRED=true</code> refuses to start without it.</td></tr>
            <tr><td><code>ADMIN_SECRET</code></td><td>production</td><td>Operator access to <code>/v1/admin/*</code> via the <code>x-admin-secret</code> header.</td></tr>
            <tr><td><code>MASTER_KEY</code>, <code>ENCRYPTION_KEY</code></td><td>production</td><td>Encrypt BYOK provider keys and connector credentials (at least 32 characters).</td></tr>
            <tr><td><code>JWT_SECRET</code></td><td>production</td><td>Signs dashboard sessions. Must be identical in the dashboard and the gateway (at least 32 characters).</td></tr>
            <tr><td><code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>GROQ_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>TOGETHER_API_KEY</code></td><td>optional</td><td>Gateway-level provider keys. You can use per-workspace BYOK keys instead.</td></tr>
            <tr><td><code>OLLAMA_BASE_URL</code></td><td>optional</td><td>Enables Ollama (no key needed).</td></tr>
            <tr><td><code>AUTH_MODE</code></td><td>optional</td><td><code>open</code> = no login, local use only. <code>jwt</code> = require sign-in.</td></tr>
            <tr><td><code>CORS_ORIGINS</code></td><td>optional</td><td>Allowed browser origins. Production default is none.</td></tr>
            <tr><td><code>METRICS_TOKEN</code></td><td>optional</td><td>Bearer token for <code>/metrics</code>.</td></tr>
            <tr><td><code>SLACK_WEBHOOK_URL</code>, <code>SMTP_URL</code> + <code>ALERT_EMAIL_TO</code></td><td>optional</td><td>Where alerts and approval requests are sent.</td></tr>
            <tr><td><code>MOCK_PROVIDER=1</code></td><td>optional</td><td>Enables the offline <code>mock:</code> provider.</td></tr>
          </tbody>
        </table></div>
        </section>
        <section>
        <h2 id="auth"><span className="num mono">05</span>Authentication &amp; roles</h2>
        <p>There are two kinds of credentials:</p>
        <ul>
          <li><b>Virtual keys</b> (<code>tktt_live_…</code>) — what your applications use against <code>/v1/chat/completions</code>. Shown once at creation.</li>
          <li><b>Management credentials</b> — either the operator <code>x-admin-secret</code> header (pass <code>organization_id</code>), or a dashboard session JWT as <code>Authorization: Bearer …</code>, locked to the user&apos;s organization and limited by role.</li>
        </ul>
        <p>By default (<code>AUTH_MODE=open</code>) the dashboard opens directly as owner of a local workspace. That is for trying it on your own machine. Set <code>AUTH_MODE=jwt</code> to require sign-in, and put your own auth proxy in front before exposing the dashboard beyond localhost.</p>
        <div className="dtable-wrap"><table>
          <thead><tr><th>Permission</th><th>owner</th><th>admin</th><th>finance</th><th>developer</th><th>viewer</th></tr></thead>
          <tbody>
            <tr><td>Read spend, budgets, policies</td><td>✔</td><td>✔</td><td>✔</td><td>✔</td><td>✔</td></tr>
            <tr><td>Write budgets</td><td>✔</td><td>✔</td><td>✔</td><td></td><td></td></tr>
            <tr><td>Write policies, routing, keys</td><td>✔</td><td>✔</td><td></td><td>✔</td><td></td></tr>
            <tr><td>Decide approvals, export reports, read audit</td><td>✔</td><td>✔</td><td>✔</td><td></td><td></td></tr>
            <tr><td>Manage connectors</td><td>✔</td><td>✔</td><td></td><td></td><td></td></tr>
          </tbody>
        </table></div>
        </section>
        <section>
        <h2 id="local-dev"><span className="num mono">06</span>Local development</h2>
        <p>Requires Node 20+ and Docker (for Postgres and Redis only).</p>
        <Code lang="bash">{`npm install
npm run dev:deps          # Postgres on :5433, Redis on :6380

export DATABASE_URL=postgres://tokenistt:tokenistt@localhost:5433/tokenistt
export REDIS_URL=redis://localhost:6380
npm run migrate           # apply the schema

# terminal 1 — gateway on :3100
cd apps/gateway
MOCK_PROVIDER=1 PORT=3100 ADMIN_SECRET=<32+ chars> MASTER_KEY=<32+ chars> JWT_SECRET=<32+ chars> npm run dev

# terminal 2 — dashboard on :3101
cd apps/dashboard
JWT_SECRET=<same as gateway> STRICT_AUTH=true GATEWAY_URL=http://localhost:3100 \\
  ADMIN_SECRET=<same as gateway> npx next dev -p 3101`}</Code>
        <p>The two <code>JWT_SECRET</code> values must match: the dashboard signs sessions and the gateway verifies them.</p>
        </section>
        <section>
        <h2 id="production"><span className="num mono">07</span>Production checklist</h2>
        <ul>
          <li>Generate every secret with <code>openssl rand -hex 32</code>. Never reuse example values.</li>
          <li>Set <code>AUTH_MODE=jwt</code> so the dashboard requires sign-in.</li>
          <li>Run Redis and set <code>REDIS_REQUIRED=true</code> for multi-instance deployments.</li>
          <li>Set <code>CORS_ORIGINS</code> to the exact origins that need browser access.</li>
          <li>Set <code>METRICS_TOKEN</code>, or keep <code>/metrics</code> on a private network.</li>
          <li>Configure <code>SLACK_WEBHOOK_URL</code> or SMTP so budget alerts and approval requests reach someone.</li>
          <li>Back up Postgres. It is the single source of truth for events, budgets, policies and audit.</li>
          <li>Terminate TLS in front of the gateway and dashboard.</li>
        </ul>
        </section>
        <section>
        <h2 id="first-request"><span className="num mono">08</span>Your first request</h2>
        <p>Create a virtual key (the token is shown once), then use it exactly like an OpenAI key.</p>
        <Step n={1} title="Create a virtual key">
          <Code lang="bash">{`curl -s -X POST "http://localhost:3000/v1/admin/keys?organization_id=$ORG" \
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"name":"my-app","budgetCapUsd":50}'`}</Code>
        </Step>
        <Step n={2} title="Call the gateway like OpenAI">
          <Code lang="bash">{`curl -s http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer tktt_live_…" -H 'content-type: application/json' \
  -H 'x-tokenistt-feature: search' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'`}</Code>
        </Step>
        <Step n={3} title="See the cost">
          <p>It comes back in the <code>x-tokenistt-cost</code> header and in <code>_tokenistt</code> in the body, and the request appears on the dashboard&apos;s Request history page.</p>
        </Step>
        <p>Use <code>mock:echo</code> as the model to try the pipeline without a real provider key (requires <code>MOCK_PROVIDER=1</code>).</p>
        <p>Other endpoints: <code>POST /v1/batch/chat/completions</code> (up to 20 requests through the full pipeline), <code>GET /v1/logs</code> (your key&apos;s history), <code>GET /v1/models</code>, <code>GET /health</code>, <code>GET /metrics</code>.</p>
        </section>
        <section>
        <h2 id="sdk"><span className="num mono">09</span>SDKs</h2>
        <p>Because the gateway is OpenAI-compatible, the official OpenAI SDKs work by changing the base URL. There is also a first-party TypeScript client.</p>
        <Code lang="typescript">{`import Tokenistt from '@tokenistt/sdk';

const client = new Tokenistt({
  apiKey: process.env.TOKENISTT_KEY,
  baseURL: 'http://localhost:3000/v1',
  defaultHeaders: { 'x-tokenistt-feature': 'search' }, // attribution on every call
});

const res = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
});`}</Code>
        <p>A Python client lives in <code>packages/sdk-python</code>.</p>
        </section>
        <section>
        <h2 id="headers"><span className="num mono">10</span>Request headers</h2>
        <div className="dtable-wrap"><table>
          <thead><tr><th>Header</th><th>Effect</th></tr></thead>
          <tbody>
            <tr><td><code>x-provider</code></td><td>Force a specific provider.</td></tr>
            <tr><td><code>x-tokenistt-team</code>, <code>x-tokenistt-project</code></td><td>Attribute to a team or project by slug, so team/project budgets apply.</td></tr>
            <tr><td><code>x-tokenistt-repo</code>, <code>-ticket</code>, <code>-sprint</code>, <code>-feature</code>, <code>-customer</code>, <code>-employee</code>, <code>-environment</code></td><td>Free-form attribution dimensions.</td></tr>
            <tr><td><code>x-tokenistt-cache: true</code></td><td>Serve identical temperature-0 requests from cache at zero cost. <code>always</code> ignores temperature.</td></tr>
            <tr><td><code>x-tokenistt-compress: true</code></td><td>Collapse redundant whitespace and drop duplicate consecutive messages.</td></tr>
          </tbody>
        </table></div>
        </section>
        <section>
        <h2 id="attribution"><span className="num mono">11</span>Cost attribution</h2>
        <p>
          Send the <code>x-tokenistt-*</code> headers and spend is broken down by those dimensions on the Cost attribution page and
          via <code>GET /v1/admin/attribution</code>. Connectors (below) pull names for repos, tickets, sprints, customers and people from your
          tools so IDs in your headers resolve to readable names.
        </p>
        </section>
        <section>
        <h2 id="byok"><span className="num mono">12</span>Provider keys (BYOK)</h2>
        <p>Add your own provider keys from <b>Providers &amp; Keys</b> in the dashboard, or through the API. Keys are encrypted with AES-256-GCM using a per-organization key and are write-only: the secret is never returned.</p>
        <Code lang="bash">{`curl -X POST $GW/v1/admin/provider-keys \\
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \\
  -d '{"organization_id":1,"provider":"openai","api_key":"sk-…","priority":1}'`}</Code>
        <p>The lowest priority number is tried first. If a key is rate-limited or rejected, the gateway falls through to the next key, then the next provider.</p>
        </section>
        <section>
        <h2 id="budgets"><span className="num mono">13</span>Budgets</h2>
        <p>Budgets can be scoped to an organization, team, project or virtual key. Each budget is measured only against its own spend.</p>
        <div className="dtable-wrap"><table>
          <thead><tr><th>Mode</th><th>Behavior</th></tr></thead>
          <tbody>
            <tr><td><code>alert_only</code></td><td>Never blocks. Sends alerts at thresholds. Safe default.</td></tr>
            <tr><td><code>auto_throttle</code></td><td>Slows or downgrades traffic as the cap approaches.</td></tr>
            <tr><td><code>hard_cap</code></td><td>Rejects requests once the cap is reached. Opt-in only.</td></tr>
          </tbody>
        </table></div>
        <Code lang="bash">{`curl -X POST $GW/v1/admin/budgets \\
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \\
  -d '{"organization_id":1,"scope_type":"team","scope_id":4,"cap_usd":300,"enforcement_mode":"hard_cap"}'`}</Code>
        </section>
        <section>
        <h2 id="governance"><span className="num mono">14</span>Policies &amp; approvals</h2>
        <p>A policy has <b>conditions</b> (for example a prompt keyword, model or team) and an <b>effect</b>: <code>allow</code>, <code>block</code>, <code>force_model</code> or <code>require_approval</code>.</p>
        <Code lang="bash">{`curl -X POST $GW/v1/admin/policies \\
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \\
  -d '{"organization_id":1,"name":"Prod deploys",
       "conditions":{"prompt_keyword":"deploy-prod"},
       "actions":{"effect":"require_approval"}}'`}</Code>
        <p>A held request returns <code>403</code> with <code>{`{"error":{"code":"approval_required","approval_id":"…"}}`}</code> and appears on the <b>Approvals</b> page. An admin approves or denies it (or calls <code>POST /v1/admin/approvals/&lt;id&gt;/approve</code>); the caller then retries and the request passes.</p>
        </section>
        <section>
        <h2 id="routing"><span className="num mono">15</span>Routing &amp; failover</h2>
        <p>Routing is opt-in. A rule matches requests and chooses targets by strategy: <code>cheapest</code>, <code>fastest</code>, <code>policy</code> or <code>fallback</code>.</p>
        <Code lang="bash">{`curl -X POST $GW/v1/admin/routing-rules \\
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \\
  -d '{"organization_id":1,"name":"cheap summaries","strategy":"cheapest",
       "match":{"model":"summar"},
       "targets":[{"provider":"openai","model":"gpt-4o-mini"},
                  {"provider":"groq","model":"llama-3.3-70b"}]}'`}</Code>
        <p>Provider errors fail over to the next candidate. A per-provider circuit breaker stops sending traffic to a provider that is down.</p>
        </section>
        <section>
        <h2 id="alerts"><span className="num mono">16</span>Alerts</h2>
        <p>Budget thresholds, anomalies and approval requests are sent to Slack (<code>SLACK_WEBHOOK_URL</code>), a webhook, or email (<code>SMTP_URL</code> + <code>ALERT_EMAIL_TO</code>). Alerts are deduplicated. The history is on the <b>Alerts</b> page.</p>
        </section>
        <section>
        <h2 id="connectors"><span className="num mono">17</span>Connectors</h2>
        <p>Available: GitHub, Jira, Slack, Linear, Google Analytics 4, Salesforce, CI/CD deployments and signed custom webhooks.</p>
        <Code lang="bash">{`curl -X POST $GW/v1/admin/connectors \\
  -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \\
  -d '{"organization_id":1,"type":"github","name":"acme-gh","config":{"token":"ghp_…","org":"acme"}}'

curl -X POST $GW/v1/admin/connectors/<id>/sync -H "x-admin-secret: $ADMIN_SECRET"`}</Code>
        <p>Credentials are verified at creation, stored encrypted and never returned. Push-based connectors (CI/CD, custom webhook) receive signed payloads at <code>POST /v1/webhooks/connectors/&lt;id&gt;</code>. Outbound URLs are SSRF-guarded.</p>
        </section>
        <section>
        <h2 id="audit"><span className="num mono">18</span>Audit log</h2>
        <p>Two append-only tables record what happened: <code>audit_log</code> (admin actions) and <code>policy_audit_log</code> (policy, budget and routing decisions). The database rejects <code>UPDATE</code> and <code>DELETE</code> on them. Read them on the <b>Audit log</b> page. Usage events are immutable too — corrections are new events, never edits.</p>
        </section>
        <section>
        <h2 id="admin-api"><span className="num mono">19</span>Management API</h2>
        <p>
          All management endpoints live under <code>/v1/admin/*</code>. Authenticate with <code>x-admin-secret</code> (operator) or a session JWT.
          Every mutation is written to the audit log. The complete list — budgets, policies, routing rules, alerts, audit, approvals,
          workspaces, teams, projects, provider keys, connectors, attribution, request history and CSV export — is in the OpenAPI document:
        </p>
        <Code lang="http">{`GET /v1/openapi.json`}</Code>
        </section>
        <section>
        <h2 id="dashboard"><span className="num mono">20</span>Dashboard pages</h2>
        <div className="dtable-wrap"><table>
          <thead><tr><th>Page</th><th>What it shows</th></tr></thead>
          <tbody>
            <tr><td>Overview, Usage</td><td>Spend, request volume, providers, anomalies.</td></tr>
            <tr><td>Request history</td><td>Every request with model, cost, latency and attribution.</td></tr>
            <tr><td>Alerts, Approvals, Audit log</td><td>What needs attention and what changed.</td></tr>
            <tr><td>Budgets, Governance, Routing</td><td>Configure enforcement, policies and routing rules.</td></tr>
            <tr><td>Providers &amp; Keys, Connectors</td><td>Your provider keys and integrations.</td></tr>
            <tr><td>Cost attribution, Cost centers, Chargebacks, Unit economics</td><td>Break spend down by team, feature, customer and more.</td></tr>
            <tr><td>Shadow AI, Reconciliation, Forecasting, Model comparison</td><td>Unmanaged usage, invoice matching, projections, model cost trade-offs.</td></tr>
            <tr><td>Team, Settings</td><td>Members, roles and workspace keys.</td></tr>
          </tbody>
        </table></div>
        </section>
        <section>
        <h2 id="mcp"><span className="num mono">21</span>MCP server</h2>
        <p>
          <code>apps/mcp-server</code> exposes Tokenistt to AI agents as MCP tools: spend summary, budget status, cost estimate, routing and more.
          Point it at your deployment with <code>TOKENISTT_DASHBOARD_URL</code>. See <code>apps/mcp-server/README.md</code> for client configuration.
        </p>
        </section>
        <section>
        <h2 id="troubleshooting"><span className="num mono">22</span>Troubleshooting</h2>
        <div className="dtable-wrap"><table>
          <thead><tr><th>Symptom</th><th>Likely cause and fix</th></tr></thead>
          <tbody>
            <tr><td>Dashboard shows no data</td><td>No requests have gone through the gateway yet, or the dashboard cannot reach Postgres or the gateway. Check <code>DATABASE_URL</code> and <code>GATEWAY_URL</code>, then send a request.</td></tr>
            <tr><td>Cost is <code>$0.00</code> with <code>COST_UNAVAILABLE</code></td><td>The model has no price in the catalog. Prices are never guessed — add one.</td></tr>
            <tr><td>401 from the gateway</td><td>Wrong or revoked virtual key. Keys are shown once; create a new one.</td></tr>
            <tr><td>Dashboard session rejected by the gateway</td><td><code>JWT_SECRET</code> differs between dashboard and gateway.</td></tr>
            <tr><td>Gateway refuses to start</td><td>Missing or short secrets in production (needs 32+ characters), or <code>REDIS_REQUIRED=true</code> without Redis.</td></tr>
            <tr><td>Request returns 403 <code>approval_required</code></td><td>A policy is holding it. Approve it on the Approvals page, then retry.</td></tr>
            <tr><td>Browser calls blocked by CORS</td><td>Add the origin to <code>CORS_ORIGINS</code>.</td></tr>
            <tr><td>Port already in use</td><td>Change <code>GATEWAY_PORT</code>, <code>DASHBOARD_PORT</code>, <code>POSTGRES_PORT</code> or <code>REDIS_PORT</code>.</td></tr>
          </tbody>
        </table></div>
        </section>
        <section>
        <h2 id="limits"><span className="num mono">23</span>Known gaps</h2>
        <ul>
          <li>Connectors are tested against fixture servers, not the live services. Expect small fixes on first real use.</li>
          <li>Prices exist for OpenAI, Anthropic and a few others. Groq, Together and Gemini models report <code>COST_UNAVAILABLE</code> until a price is added.</li>
          <li>Not built yet: SSO (OIDC/SAML), row-level security, pluggable secrets managers, multi-instance event queue, request replay, and a CLI.</li>
          <li>Single Postgres instance; no multi-region story.</li>
        </ul>
        </section>
        <div className="docs-foot mono">Tokenistt · AI cost visibility and governance for growing teams.</div>
      </main>
    </DocsFrame>
  );
}
