import { getPool } from './pool.js';
import { AuthContext } from './auth.js';
import { OpenAIChatCompletionRequest } from '../types/index.js';
import { estimateRequestTokens } from '../providers/base.js';
import { calculateCost } from '../services/pricing.js';

export interface Policy {
  id: string;
  public_id: string;
  name: string;
  description?: string;
  is_enabled: boolean;
  conditions: {
    cost_center?: string;
    model?: string;
    cost_limit?: number;
    prompt_keyword?: string;
  };
  actions: {
    effect: 'block' | 'require_approval' | 'force_model';
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
        id          bigserial PRIMARY KEY,
        public_id   uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        description text,
        is_enabled  boolean NOT NULL DEFAULT true,
        conditions  jsonb NOT NULL DEFAULT '{}'::jsonb,
        actions     jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
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
export async function checkPolicies(
  auth: AuthContext,
  request: OpenAIChatCompletionRequest
): Promise<{
  allowed: boolean;
  reason?: string;
  modifiedRequest?: OpenAIChatCompletionRequest;
}> {
  if (!process.env.DATABASE_URL) {
    return { allowed: true }; // Open mode
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query<Policy>(
      'SELECT id::text, public_id::text, name, description, is_enabled, conditions, actions FROM policies WHERE is_enabled = true'
    );

    let modifiedRequest = { ...request };
    let wasModified = false;

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

      // If we reach here, all specified conditions in the policy match!
      console.log(`[Policy Match] Applied policy: "${name}"`);

      if (actions.effect === 'block') {
        return {
          allowed: false,
          reason: actions.message || `Request blocked by policy: "${name}"`
        };
      }

      if (actions.effect === 'require_approval') {
        return {
          allowed: false,
          reason: actions.message || `Request requires administrative approval under policy: "${name}"`
        };
      }

      if (actions.effect === 'force_model' && actions.model) {
        modifiedRequest.model = actions.model;
        wasModified = true;
        console.log(`[Policy Action] Forced model redirection: ${request.model} -> ${actions.model}`);
      }
    }

    return {
      allowed: true,
      modifiedRequest: wasModified ? modifiedRequest : undefined
    };

  } catch (err: any) {
    console.error('[Policies] Error checking policies:', err.message);
    return { allowed: true }; // Fail-open on policy execution error
  }
}
