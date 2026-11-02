import { getPool } from './pool.js';
import { AuthContext } from './auth.js';
import { OpenAIChatCompletionRequest } from '../types/index.js';
import { estimateRequestTokens } from '../providers/base.js';
import { calculateCost } from '../services/pricing.js';
import { logDecision } from '../services/auditLogger.js';
import { createApproval, findApproval, requestFingerprint } from '../services/approvals.js';

export interface Policy {
  id: string;
  public_id: string;
  organization_id?: bigint | null;
  name: string;
  description?: string;
  is_enabled: boolean;
  conditions: {
    cost_center?: string;
    model?: string;
    cost_limit?: number;
    prompt_keyword?: string;
    /** Matches when ANY listed attribution field (team, project, repo, ticket, feature, …) is missing from the request. */
    missing_attribution?: string[];
    /** Matches when the requested model contains NONE of these substrings (an allow-list). */
    model_not_in?: string[];
  };
  actions: {
    effect: 'allow' | 'deny' | 'block' | 'require_approval' | 'force_model';
    model?: string;
    message?: string;
  };
}

/** Ensure the policies table exists and is seeded with examples. */
export async function migratePolicies(): Promise<void> {
  const pool = getPool();
  try {
    // 1. Create table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS policies (
        id              bigserial PRIMARY KEY,
        public_id       uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
        organization_id bigint,
        name            text NOT NULL,
        description     text,
        is_enabled      boolean NOT NULL DEFAULT true,
        conditions      jsonb NOT NULL DEFAULT '{}'::jsonb,
        actions         jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Ensure organization_id column exists if table was previously created without it
    await pool.query(`
      ALTER TABLE policies ADD COLUMN IF NOT EXISTS organization_id bigint;
      CREATE INDEX IF NOT EXISTS ix_policies_org ON policies (organization_id, is_enabled);
    `);

    // 2. Seed default policies if table is empty
    const { rows } = await pool.query('SELECT COUNT(*) FROM policies');
    if (parseInt(rows[0].count, 10) === 0) {
      console.log('[Policies] Seeding default policies...');
      
      // Policy 1: Block GPT-4 for Interns
      await pool.query(
        `INSERT INTO policies (name, description, is_enabled, conditions, actions) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'Block GPT-4 for Interns',
          'Block high-cost GPT-4 model requests from the Intern cost center team.',
          true,
          JSON.stringify({ cost_center: 'interns', model: 'gpt-4' }),
          JSON.stringify({ effect: 'block', message: 'GPT-4 access is forbidden for the Intern team to manage budgets.' })
        ]
      );

      // Policy 2: Require approval for requests over $0.50
      await pool.query(
        `INSERT INTO policies (name, description, is_enabled, conditions, actions) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'Require Approval for High Cost',
          'Require approval for any API request with estimated cost exceeding $0.50.',
          true,
          JSON.stringify({ cost_limit: 0.50 }),
          JSON.stringify({ effect: 'require_approval', message: 'Request exceeds the policy pre-flight limit of $0.50. Approval is required.' })
        ]
      );

      // Policy 3: Force Haiku for Summarization Tasks
      await pool.query(
        `INSERT INTO policies (name, description, is_enabled, conditions, actions) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'Force Haiku for Summarization',
          'Redirect any summarization tasks calling GPT-4 to the cost-efficient Claude 3 Haiku model.',
          true,
          JSON.stringify({ prompt_keyword: 'summarize', model: 'gpt-4' }),
          JSON.stringify({ effect: 'force_model', model: 'claude-3-haiku' })
        ]
      );
      
      console.log('[Policies] Default policies seeded successfully.');
    }
  } catch (err: any) {
    console.error('[Policies] Migration failed:', err.message);
  }
}

/** Check if any active policy matches the incoming request and apply actions. */
export interface PolicyResult {
  allowed: boolean;
  reason?: string;
  /** Machine-readable code for the client (policy_violation | approval_required | approval_denied) */
  code?: string;
  approvalId?: string;
  modifiedRequest?: OpenAIChatCompletionRequest;
  /** Name of the policy that decided the outcome (set for block / approval / force_model / allow). */
  matchedPolicy?: string;
}

export interface CheckPoliciesOptions {
  /** Evaluate only: write no audit rows and create no approval requests (used by `policies/test`). */
  dryRun?: boolean;
}

export async function checkPolicies(
  auth: AuthContext,
  request: OpenAIChatCompletionRequest,
  requestId?: string,
  opts: CheckPoliciesOptions = {}
): Promise<PolicyResult> {
  if (!process.env.DATABASE_URL) {
    return { allowed: true }; // Open mode
  }

  try {
    const pool = getPool();
    const orgIdStr = auth.organizationId ? auth.organizationId.toString() : null;
    const { rows } = await pool.query<Policy>(
      `SELECT id::text, public_id::text, name, description, is_enabled, conditions, actions 
       FROM policies 
       WHERE is_enabled = true 
         AND (organization_id IS NULL OR organization_id = $1)`,
      [orgIdStr]
    );

    let modifiedRequest = { ...request };
    let wasModified = false;
    let forcedBy: string | undefined;

    // Estimate pre-flight input cost
    const inputTokens = estimateRequestTokens(request.messages);
    const provider = request.model.startsWith('openai:') ? 'openai' : 
                     request.model.toLowerCase().includes('claude') ? 'anthropic' : 'openai';
    const estimatedInputCost = calculateCost(provider, request.model, inputTokens, 0);

    // Concatenate all prompt message contents to scan for keywords
    const fullPromptText = request.messages
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
      .toLowerCase();

    for (const policy of rows) {
      const { conditions, actions, name } = policy;

      // 1. Check Model Match
      if (conditions.model) {
        const reqModel = request.model.toLowerCase();
        const condModel = conditions.model.toLowerCase();
        if (!reqModel.includes(condModel)) {
          continue; // No match
        }
      }

      // 2. Check Cost Center Match
      if (conditions.cost_center) {
        const reqCC = (auth.costCenter || '').toLowerCase();
        const condCC = conditions.cost_center.toLowerCase();
        if (reqCC !== condCC) {
          continue; // No match
        }
      }

      // 3. Check Pre-flight Cost Limit Match
      if (conditions.cost_limit) {
        if (estimatedInputCost < conditions.cost_limit) {
          continue; // Under limit
        }
      }

      // 4. Check Prompt Keyword Match
      if (conditions.prompt_keyword) {
        const kw = conditions.prompt_keyword.toLowerCase();
        if (!fullPromptText.includes(kw)) {
          continue; // Keyword not found
        }
      }

      // 5. Enforcement: required attribution (every request must say who/what it is for)
      if (conditions.missing_attribution?.length) {
        const a = (auth.attribution ?? {}) as Record<string, unknown>;
        const present = (field: string) => {
          const v = field === 'team' ? a.teamId : field === 'project' ? a.projectId : a[field];
          return v !== null && v !== undefined && v !== '';
        };
        if (conditions.missing_attribution.every(present)) continue; // all supplied → compliant
      }

      // 6. Enforcement: model allow-list
      if (conditions.model_not_in?.length) {
        const reqModel = request.model.toLowerCase();
        if (conditions.model_not_in.some(m => reqModel.includes(String(m).toLowerCase()))) continue; // allowed
      }

      // If we reach here, all specified conditions in the policy match!
      console.log(`[Policy Match] Applied policy: "${name}"`);

      const audit = (decision: string, reason?: string, extra?: Record<string, unknown>) =>
        opts.dryRun ? undefined : logDecision({
          organizationId: auth.organizationId,
          kind: 'policy',
          subjectId: policy.public_id,
          requestId,
          decision,
          reason,
          metadata: { policy: name, model: request.model, costCenter: auth.costCenter, ...extra },
        });

      if (actions.effect === 'allow') {
        audit('allow');
        return { allowed: true, modifiedRequest: wasModified ? modifiedRequest : undefined, matchedPolicy: name };
      }

      if (actions.effect === 'block' || actions.effect === 'deny') {
        const reason = actions.message || `Request blocked by policy: "${name}"`;
        audit('block', reason);
        return { allowed: false, reason, code: 'policy_violation', matchedPolicy: name };
      }

      if (actions.effect === 'require_approval') {
        const fingerprint = requestFingerprint(auth, request);
        const existing = await findApproval(auth.organizationId, fingerprint);

        if (existing?.status === 'approved') {
          audit('approved', 'Previously approved request', { approvalId: existing.public_id });
          continue; // approved: this policy no longer gates the request
        }
        if (existing?.status === 'denied') {
          const reason = `Approval ${existing.public_id} was denied by ${existing.decided_by ?? 'an administrator'}.`;
          audit('block', reason, { approvalId: existing.public_id });
          return { allowed: false, reason, code: 'approval_denied', approvalId: existing.public_id, matchedPolicy: name };
        }

        const reason = actions.message || `Request requires administrative approval under policy: "${name}"`;
        if (opts.dryRun && !existing) return { allowed: false, reason, code: 'approval_required', matchedPolicy: name };
        const approval = existing ?? (await createApproval({
          auth, policyId: policy.id, fingerprint, model: request.model, reason,
        }));
        audit('require_approval', reason, { approvalId: approval.public_id });
        return { allowed: false, reason, code: 'approval_required', approvalId: approval.public_id, matchedPolicy: name };
      }

      if (actions.effect === 'force_model' && actions.model) {
        modifiedRequest.model = actions.model;
        wasModified = true;
        forcedBy = name;
        if (!opts.dryRun) logDecision({
          organizationId: auth.organizationId, kind: 'policy', subjectId: policy.public_id, requestId,
          decision: 'force_model', reason: `${request.model} -> ${actions.model}`,
          metadata: { policy: name },
        });
        console.log(`[Policy Action] Forced model redirection: ${request.model} -> ${actions.model}`);
      }
    }

    return {
      allowed: true,
      modifiedRequest: wasModified ? modifiedRequest : undefined,
      matchedPolicy: forcedBy,
    };

  } catch (err: any) {
    console.error('[Policies] Error checking policies:', err.message);
    return { allowed: true }; // Fail-open on policy execution error
  }
}
