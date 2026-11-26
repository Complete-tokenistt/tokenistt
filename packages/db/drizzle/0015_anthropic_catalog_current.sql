-- =============================================================================
-- 0015_anthropic_catalog_current.sql
-- Current Anthropic (first-party Claude API) prices.
--
-- Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-26.
-- Every number below is copied from that page's model pricing table; none is derived or guessed.
--   input_price_per_1m         = "Base input tokens"
--   cache_write_price_per_1m   = "5m cache writes" (1-hour cache writes are not modelled yet)
--   cached_input_price_per_1m  = "Cache hits and refreshes"
--   output_price_per_1m        = "Output tokens"
-- Cache hits are not always 0.1x input: 0.05x on Opus 5.5 / Sonnet 5.5, 0.025x on Fable / Mythos 5.1 and 5.2.
--
-- effective_from is the date the price was checked, not the model's launch date.
--
-- Deliberately left out:
--   * claude-haiku-5-5: priced by prompt length (prompts over 100K tokens pay more). A catalog row holds one
--     price, so it stays COST_UNAVAILABLE rather than being priced wrong for long prompts.
--   * Retired models (Opus 4.1, Opus 4, Sonnet 4): no longer served by the first-party API.
--   * Bedrock / Vertex: partner-operated, separately priced.
--   * Fast mode, batch, and the 1.1x US inference_geo multiplier: request modifiers, not per-model rows.
--
-- Rows are insert-only (pricing is versioned): a later price change is a new row with a later effective_from.
-- =============================================================================

INSERT INTO model_catalog (
    provider, model_id, display_name, context_window_tokens, max_output_tokens,
    input_price_per_1m, cache_write_price_per_1m, cached_input_price_per_1m, output_price_per_1m,
    status, effective_from
)
VALUES
('anthropic', 'claude-fable-5-2',  'Claude Fable 5.2',  1000000, 128000,  8.00, 10.00, 0.20, 40.00, 'active', '2026-11-26'),
('anthropic', 'claude-mythos-5-2', 'Claude Mythos 5.2', 1000000, 128000,  8.00, 10.00, 0.20, 40.00, 'active', '2026-11-26'),
('anthropic', 'claude-fable-5-1',  'Claude Fable 5.1',  1000000, 128000, 10.00, 12.50, 0.25, 50.00, 'active', '2026-11-26'),
('anthropic', 'claude-mythos-5-1', 'Claude Mythos 5.1', 1000000, NULL,   10.00, 12.50, 0.25, 50.00, 'active', '2026-11-26'),
('anthropic', 'claude-fable-5',    'Claude Fable 5',    1000000, 128000, 10.00, 12.50, 1.00, 50.00, 'active', '2026-11-26'),
('anthropic', 'claude-mythos-5',   'Claude Mythos 5',   NULL,    NULL,   10.00, 12.50, 1.00, 50.00, 'active', '2026-11-26'),
('anthropic', 'claude-opus-5-5',   'Claude Opus 5.5',   1000000, 128000,  4.00,  5.00, 0.20, 20.00, 'active', '2026-11-26'),
('anthropic', 'claude-opus-5',     'Claude Opus 5',     1000000, 128000,  5.00,  6.25, 0.50, 25.00, 'active', '2026-11-26'),
('anthropic', 'claude-opus-4-8',   'Claude Opus 4.8',   1000000, 128000,  5.00,  6.25, 0.50, 25.00, 'active', '2026-11-26'),
('anthropic', 'claude-opus-4-7',   'Claude Opus 4.7',   1000000, 128000,  5.00,  6.25, 0.50, 25.00, 'active', '2026-11-26'),
('anthropic', 'claude-opus-4-6',   'Claude Opus 4.6',   1000000, 128000,  5.00,  6.25, 0.50, 25.00, 'active', '2026-11-26'),
('anthropic', 'claude-opus-4-5',   'Claude Opus 4.5',   NULL,    NULL,    5.00,  6.25, 0.50, 25.00, 'active', '2026-11-26'),
('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, 128000,  2.00,  2.50, 0.10, 10.00, 'active', '2026-11-26'),
('anthropic', 'claude-sonnet-5',   'Claude Sonnet 5',   1000000, 128000,  2.00,  2.50, 0.20, 10.00, 'active', '2026-11-26'),
('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000000, 128000,  3.00,  3.75, 0.30, 15.00, 'active', '2026-11-26'),
('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', NULL,    NULL,    3.00,  3.75, 0.30, 15.00, 'active', '2026-11-26'),
('anthropic', 'claude-haiku-4-5',  'Claude Haiku 4.5',  200000,  NULL,    1.00,  1.25, 0.10,  5.00, 'active', '2026-11-26')
ON CONFLICT (provider, model_id, effective_from) DO NOTHING;
