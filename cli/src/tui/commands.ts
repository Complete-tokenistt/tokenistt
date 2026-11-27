/** The command set behind the prompt and the Ctrl+K palette. Pure data plus a parser, so both share one source. */

export const SCREENS = ['Home', 'Agents', 'Memory', 'Graph', 'Nano', 'FinOps'] as const;
export type Screen = (typeof SCREENS)[number];

export interface CommandSpec { name: string; hint: string; arg?: string; screen?: Screen }

export const COMMANDS: CommandSpec[] = [
  { name: 'home', hint: 'Project overview and activity', screen: 'Home' },
  { name: 'agents', hint: 'Coding agents and their sessions', screen: 'Agents' },
  { name: 'memory', hint: 'What the project remembers', screen: 'Memory' },
  { name: 'graph', hint: 'Codebase knowledge graph', screen: 'Graph' },
  { name: 'nano', hint: 'Nano (not built yet)', screen: 'Nano' },
  { name: 'finops', hint: 'Spend, models and budgets from your gateway', screen: 'FinOps' },
  { name: 'search', hint: 'Search symbols, files and memory', arg: '<text>' },
  { name: 'refresh', hint: 'Reload data now' },
  { name: 'clear', hint: 'Clear the activity feed' },
  { name: 'help', hint: 'Keys and commands' },
  { name: 'quit', hint: 'Leave the dashboard' },
];

/** Every real CLI command. A test keeps this in step with the program, so typing one at the prompt runs it. */
export const CLI_COMMANDS = ['setup', 'run', 'login', 'logout', 'auth', 'connect', 'disconnect', 'connection', 'doctor', 'init', 'map', 'graph', 'agents', 'sessions', 'watch', 'memory', 'context', 'mcp', 'impact', 'changes', 'search', 'embeddings', 'analyze', 'sync', 'usage', 'cost', 'models', 'providers', 'policy', 'optimize'];
export const CLI_HELP: Array<[string, string]> = [
  ['init', 'set up this repository (creates .tokenistt/)'], ['map', 'build the codebase knowledge graph'], ['graph --open', 'explore the graph in your browser'],
  ['search <text>', 'find symbols and files'], ['impact <target>', 'what a change could affect'], ['changes', 'what changed and what it touches'],
  ['analyze', 'structure checks: cycles, dead code, duplicates'], ['memory', 'what the project remembers'], ['context', 'generate context for a coding agent'],
  ['agents', 'connect Claude Code and others'], ['sessions', 'recorded agent sessions'], ['doctor', 'check install, credentials and gateway'],
  ['usage', 'requests and tokens from your gateway'], ['cost', 'what it cost, by model and more'], ['models', 'gateway model catalog (--refresh saves prices)'], ['optimize', 'rules-based cost suggestions'], ['sync', 'send summaries to your gateway'],
  ['connect', 'link to your gateway'], ['auth', 'credentials'], ['login', 'sign in (needs its own terminal)'], ['watch', 'live sessions (needs its own terminal)'], ['mcp', 'MCP server (needs its own terminal)'],
];
/** Need a real terminal of their own (prompts, or they never exit), so the app can't host them. */
export const NEEDS_TERMINAL = new Set(['login', 'setup', 'run', 'watch', 'mcp']);
const GLOBAL_OPTIONS = ['--help', '--version', '--json', '--quiet', '--verbose', '--no-color', '--api-url'];

export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

export function closest(word: string, pool: string[]): string | undefined {
  let best: string | undefined;
  let score = 3;
  for (const p of pool) { const s = distance(word.toLowerCase(), p); if (s < score) { score = s; best = p; } }
  return best;
}

export type Action =
  | { kind: 'cli'; args: string[] }
  | { kind: 'terminal'; command: string; line: string }
  | { kind: 'suggest'; typed: string; suggestion: string }
  | { kind: 'screen'; screen: Screen }
  | { kind: 'search'; query: string }
  | { kind: 'refresh' }
  | { kind: 'clear' }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'unknown'; text: string }
  | { kind: 'none' };

/** A line starting with `/` is a command; anything else is a search, like asking the tool a question. */
export function parse(text: string): Action {
  const t = text.trim();
  if (!t) return { kind: 'none' };
  if (!t.startsWith('/')) return fromText(t);
  const [head = '', ...rest] = t.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  const spec = COMMANDS.find((c) => c.name === name) ?? COMMANDS.find((c) => c.name.startsWith(name) && name.length > 0);
  if (!spec) return { kind: 'unknown', text: t };
  if (spec.screen) return { kind: 'screen', screen: spec.screen };
  switch (spec.name) {
    case 'search': return rest.join(' ') ? { kind: 'search', query: rest.join(' ') } : { kind: 'unknown', text: '/search needs some text' };
    case 'refresh': return { kind: 'refresh' };
    case 'clear': return { kind: 'clear' };
    case 'help': return { kind: 'help' };
    default: return { kind: 'quit' };
  }
}

function fromText(t: string): Action {
  const words = t.replace(/^(tokenistt|tokensitt|tokenist)\s+/i, '').split(/\s+/);
  const first = words[0] ?? '';
  if (words.length === 1 && /^(--?h(elp)?|help|\?)$/i.test(first)) return { kind: 'help' };
  const screen = COMMANDS.find((c) => c.screen && c.name === first.toLowerCase());
  if (words.length === 1 && screen?.screen) return { kind: 'screen', screen: screen.screen };
  // Adding a provider key reads it from stdin, which the app cannot give a child safely.
  if (first === 'providers' && words[1] === 'add') return { kind: 'terminal', command: 'providers add', line: words.join(' ') };
  if (CLI_COMMANDS.includes(first)) return NEEDS_TERMINAL.has(first) ? { kind: 'terminal', command: first, line: words.join(' ') } : { kind: 'cli', args: words };
  if (first.startsWith('-')) {
    const opt = first.split('=')[0]!;
    if (GLOBAL_OPTIONS.includes(opt)) return opt === '--help' ? { kind: 'help' } : { kind: 'cli', args: words };
    const s = closest(opt, GLOBAL_OPTIONS);
    return s ? { kind: 'suggest', typed: first, suggestion: s } : { kind: 'unknown', text: t };
  }
  // A single odd word is more likely a mistyped command than a search.
  if (words.length <= 2) {
    const s = closest(first, CLI_COMMANDS);
    if (s && first.length > 2) return { kind: 'suggest', typed: first, suggestion: [s, ...words.slice(1)].join(' ') };
  }
  return { kind: 'search', query: t };
}

export function matching(query: string): CommandSpec[] {
  const q = query.trim().replace(/^\//, '').toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter((c) => c.name.includes(q) || c.hint.toLowerCase().includes(q)).sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)));
}

export const HELP_LINES = [
  'Type a question or symbol to search. Start with / for commands.',
  'Tab / Shift+Tab  switch screen        Ctrl+K  command palette',
  'Up / Down        select or scroll      PgUp / PgDn  page',
  'Ctrl+L           clear activity        Ctrl+C or /quit  leave',
];
