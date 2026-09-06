/**
 * services/metrics.ts — Prometheus metrics collector and exporter.
 * Standard Prometheus text exposition format (no heavy external dependencies required).
 */

interface CounterMetric {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  values: Map<string, number>;
}

class MetricsRegistry {
  private counters: Map<string, CounterMetric> = new Map();

  constructor() {
    this.register('tokenistt_requests_total', 'Total HTTP requests processed by universal gateway', 'counter');
    this.register('tokenistt_cost_usd_total', 'Total spend in USD accumulated across requests', 'counter');
    this.register('tokenistt_tokens_prompt_total', 'Total prompt tokens consumed', 'counter');
    this.register('tokenistt_tokens_completion_total', 'Total completion tokens generated', 'counter');
    this.register('tokenistt_latency_ms_sum', 'Sum of request latency in milliseconds', 'counter');
  }

  private register(name: string, help: string, type: 'counter' | 'gauge') {
    this.counters.set(name, { name, help, type, values: new Map() });
  }

  private formatLabels(labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return '';
    const items = Object.entries(labels)
      .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
      .join(',');
    return `{${items}}`;
  }

  increment(name: string, amount = 1, labels?: Record<string, string>) {
    const metric = this.counters.get(name);
    if (!metric) return;
    const labelKey = this.formatLabels(labels);
    const current = metric.values.get(labelKey) || 0;
    metric.values.set(labelKey, current + amount);
  }

  recordTransaction(params: {
    provider: string;
    model: string;
    status: string;
    costCenter: string;
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }) {
    const labels = {
      provider: params.provider,
      model: params.model,
      status: params.status,
      cost_center: params.costCenter || 'default',
    };

    this.increment('tokenistt_requests_total', 1, labels);
    this.increment('tokenistt_cost_usd_total', params.costUsd, { provider: params.provider, model: params.model });
    this.increment('tokenistt_tokens_prompt_total', params.promptTokens, { provider: params.provider, model: params.model });
    this.increment('tokenistt_tokens_completion_total', params.completionTokens, { provider: params.provider, model: params.model });
    this.increment('tokenistt_latency_ms_sum', params.latencyMs, { provider: params.provider });
  }

  getMetricsText(): string {
    const lines: string[] = [];
    for (const metric of this.counters.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const [labelStr, val] of metric.values.entries()) {
        lines.push(`${metric.name}${labelStr} ${val}`);
      }
      if (metric.values.size === 0) {
        lines.push(`${metric.name} 0`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();

