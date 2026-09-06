-- =============================================================================
-- 0002_model_catalog.sql
-- Financial-grade Model and Pricing Catalog (Source of Truth for FinOps)
-- =============================================================================

CREATE TABLE IF NOT EXISTS model_catalog (
    id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id                   uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    provider                    text NOT NULL,          -- openai | anthropic | bedrock | azure
    model_id                    text NOT NULL,          -- exact API model string, e.g. "gpt-4o"
    display_name                text NOT NULL,
    context_window_tokens       integer,
    max_output_tokens           integer,
    input_price_per_1m          numeric(18,8) NOT NULL, -- USD
    output_price_per_1m         numeric(18,8) NOT NULL, -- USD
    cached_input_price_per_1m   numeric(18,8),          -- NULL if not supported
    reasoning_price_per_1m      numeric(18,8),          -- NULL if not applicable
    capabilities                jsonb NOT NULL DEFAULT '[]'::jsonb,
    status                      text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','deprecated','preview')),
    effective_from              date NOT NULL DEFAULT CURRENT_DATE,
    deprecated_at               date,
    created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_model_catalog_provider_model_date 
    ON model_catalog (provider, model_id, effective_from);

CREATE INDEX IF NOT EXISTS ix_model_catalog_provider_status 
    ON model_catalog (provider, status);

-- Seed initial catalog with current accurate pricing (per 1M tokens)
INSERT INTO model_catalog (provider, model_id, display_name, input_price_per_1m, output_price_per_1m, cached_input_price_per_1m, effective_from) 
VALUES
-- OpenAI
('openai', 'gpt-4o',                'GPT-4o',              2.50,  10.00,  1.25, '2024-05-13'),
('openai', 'gpt-4o-mini',           'GPT-4o mini',         0.15,   0.60, 0.075, '2024-07-18'),
('openai', 'o1',                    'o1',                 15.00,  60.00,  7.50, '2024-12-05'),
('openai', 'o1-mini',               'o1-mini',             3.00,  12.00,  1.50, '2024-09-12'),
('openai', 'o3-mini',               'o3-mini',             1.10,   4.40,  0.55, '2025-01-31'),
('openai', 'gpt-4-turbo',           'GPT-4 Turbo',        10.00,  30.00,  NULL, '2024-04-09'),
('openai', 'gpt-4',                 'GPT-4',              30.00,  60.00,  NULL, '2023-06-13'),
('openai', 'gpt-3.5-turbo',         'GPT-3.5 Turbo',       0.50,   1.50,  NULL, '2023-11-06'),

-- Anthropic
('anthropic', 'claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet', 3.00, 15.00, 0.30, '2024-10-22'),
('anthropic', 'claude-3-5-haiku-20241022',  'Claude 3.5 Haiku',  0.80,  4.00, 0.08, '2024-11-05'),
('anthropic', 'claude-3-opus-20240229',     'Claude 3 Opus',    15.00, 75.00, NULL, '2024-02-29'),
('anthropic', 'claude-3-sonnet-20240229',   'Claude 3 Sonnet',   3.00, 15.00, NULL, '2024-02-29'),
('anthropic', 'claude-3-haiku-20240307',    'Claude 3 Haiku',    0.25,  1.25, NULL, '2024-03-07'),

-- Azure OpenAI
('azure', 'gpt-4o',      'Azure GPT-4o',      2.50, 10.00, NULL, '2024-05-13'),
('azure', 'gpt-4o-mini', 'Azure GPT-4o mini', 0.15,  0.60, NULL, '2024-07-18'),
('azure', 'gpt-4',       'Azure GPT-4',      30.00, 60.00, NULL, '2023-06-13'),

-- AWS Bedrock
('bedrock', 'claude-3-5-sonnet', 'Bedrock Claude 3.5 Sonnet', 3.00, 15.00, NULL, '2024-10-22'),
('bedrock', 'claude-3-sonnet',   'Bedrock Claude 3 Sonnet',   3.00, 15.00, NULL, '2024-02-29'),
('bedrock', 'claude-3-haiku',    'Bedrock Claude 3 Haiku',    0.25,  1.25, NULL, '2024-03-07')
ON CONFLICT DO NOTHING;

