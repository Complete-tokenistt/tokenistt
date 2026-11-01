import * as vscode from 'vscode';
import { fetchRecent, fetchUsage, GatewayError, type KeyUsage, type RequestRow } from './api';
import { budgetLevel, connectionSnippet, requestDescription, requestLabel, statusBarText, statusBarTooltip, usd, ago } from './format';

const SECRET_KEY = 'tokenistt.apiKey';

interface State {
  usage?: KeyUsage;
  recent: RequestRow[];
  error?: string;
}

class UsageTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly state: () => State) {}
  refresh() { this.emitter.fire(); }
  getTreeItem(item: vscode.TreeItem) { return item; }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    const s = this.state();
    if (parent?.id === 'models') {
      return (s.usage?.top_models ?? []).map((m) => row(`${m.model}`, `${usd(m.cost_usd)} · ${m.requests} req`, 'symbol-method'));
    }
    if (parent?.id === 'recent') {
      return s.recent.map((r) => {
        const it = row(requestLabel(r), requestDescription(r), r.status === 'success' ? 'check' : 'error');
        it.tooltip = `${r.provider}:${r.model}\n${r.prompt_tokens} in / ${r.completion_tokens} out tokens\n${r.duration_ms ?? '?'} ms\n${r.status}${r.error_code ? ` (${r.error_code})` : ''}`;
        return it;
      });
    }
    if (parent) return [];
    if (s.error) return [row(s.error, 'click refresh to retry', 'warning')];
    const u = s.usage;
    if (!u) return [row('Loading…', '', 'sync')];
    const items = [
      row('Today', `${usd(u.today.cost_usd)} · ${u.today.requests} requests`, 'calendar'),
      row('This month', `${usd(u.month.cost_usd)} · ${u.month.requests} requests`, 'graph'),
    ];
    if (u.month.errors) items.push(row('Failed this month', String(u.month.errors), 'error'));
    items.push(
      u.budget
        ? row(`Budget (${u.budget.period})`, `${usd(u.budget.spent_usd)} / ${usd(u.budget.cap_usd)} · ${u.budget.percent_used}%`, 'shield')
        : row('Budget', 'no cap on this key', 'shield'),
      row('Last request', ago(u.last_request_at), 'clock'),
    );
    if (u.top_models.length) items.push(group('models', 'Top models this month', 'symbol-class'));
    if (s.recent.length) items.push(group('recent', 'Recent requests', 'history'));
    return items;
  }
}

const row = (label: string, description: string, icon: string) => {
  const it = new vscode.TreeItem(label);
  it.description = description;
  it.iconPath = new vscode.ThemeIcon(icon);
  return it;
};
const group = (id: string, label: string, icon: string) => {
  const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
  it.id = id;
  it.iconPath = new vscode.ThemeIcon(icon);
  return it;
};

export function activate(ctx: vscode.ExtensionContext) {
  const state: State = { recent: [] };
  const cfg = () => vscode.workspace.getConfiguration('tokenistt');
  const gatewayUrl = () => cfg().get<string>('gatewayUrl', 'http://localhost:3000');
  const dashboardUrl = () => cfg().get<string>('dashboardUrl', 'http://localhost:3001').replace(/\/+$/, '');

  const tree = new UsageTree(() => state);
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  bar.command = 'tokenistt.refresh';
  ctx.subscriptions.push(bar, vscode.window.registerTreeDataProvider('tokenistt.usage', tree));

  let warnedFor = '';
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const key = await ctx.secrets.get(SECRET_KEY);
      await vscode.commands.executeCommand('setContext', 'tokenistt.hasKey', !!key);
      if (!key) {
        state.usage = undefined; state.recent = []; state.error = undefined;
        bar.text = '$(pulse) Tokenistt: set API key';
        bar.tooltip = 'Click to set your Tokenistt API key';
        bar.command = 'tokenistt.setApiKey';
        bar.show();
        return;
      }
      bar.command = 'tokenistt.refresh';
      try {
        const [usage, recent] = await Promise.all([fetchUsage(gatewayUrl(), key), fetchRecent(gatewayUrl(), key)]);
        state.usage = usage; state.recent = recent; state.error = undefined;
        bar.text = statusBarText(usage);
        bar.tooltip = statusBarTooltip(usage);
        bar.backgroundColor = undefined;
        const level = budgetLevel(usage, cfg().get<number>('budgetWarnPercent', 80));
        if (level !== 'ok') {
          bar.backgroundColor = new vscode.ThemeColor(level === 'critical' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground');
          const token = `${usage.key.prefix}:${usage.budget!.period}:${level}:${new Date().toISOString().slice(0, level === 'critical' || usage.budget!.period === 'daily' ? 10 : 7)}`;
          if (token !== warnedFor) {
            warnedFor = token;
            const msg = `Tokenistt: ${usage.budget!.percent_used}% of this key's ${usage.budget!.period} budget used (${usd(usage.budget!.spent_usd)} of ${usd(usage.budget!.cap_usd)}).`;
            void (level === 'critical' ? vscode.window.showErrorMessage(msg) : vscode.window.showWarningMessage(msg));
          }
        }
      } catch (e) {
        const err = e as GatewayError;
        state.error = err.message;
        state.usage = undefined;
        bar.text = err.kind === 'auth' ? '$(warning) Tokenistt: key rejected' : '$(warning) Tokenistt: offline';
        bar.tooltip = err.message;
        bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      }
      bar.show();
    } finally {
      inFlight = false;
      tree.refresh();
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void refresh(), Math.max(10, cfg().get<number>('refreshSeconds', 60)) * 1000);
  }

  ctx.subscriptions.push(
    { dispose: () => timer && clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tokenistt')) { schedule(); void refresh(); }
    }),
    vscode.commands.registerCommand('tokenistt.refresh', () => refresh()),
    vscode.commands.registerCommand('tokenistt.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Tokenistt API key',
        prompt: 'Paste your key (starts with tktt_). It is stored in VS Code\'s encrypted secret storage.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().startsWith('tktt_') ? undefined : 'Tokenistt keys start with "tktt_"'),
      });
      if (!key) return;
      await ctx.secrets.store(SECRET_KEY, key.trim());
      warnedFor = '';
      await refresh();
      if (!state.error) void vscode.window.showInformationMessage('Tokenistt connected.');
    }),
    vscode.commands.registerCommand('tokenistt.clearApiKey', async () => {
      await ctx.secrets.delete(SECRET_KEY);
      await refresh();
    }),
    vscode.commands.registerCommand('tokenistt.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(dashboardUrl()))),
    vscode.commands.registerCommand('tokenistt.openRequestHistory', () => vscode.env.openExternal(vscode.Uri.parse(`${dashboardUrl()}/requests`))),
    vscode.commands.registerCommand('tokenistt.copyConnectionSnippet', async () => {
      await vscode.env.clipboard.writeText(connectionSnippet(gatewayUrl(), await ctx.secrets.get(SECRET_KEY)));
      void vscode.window.showInformationMessage('Copied OPENAI_BASE_URL / OPENAI_API_KEY for your Tokenistt gateway.');
    }),
  );

  schedule();
  void refresh();
}

export function deactivate() {}
