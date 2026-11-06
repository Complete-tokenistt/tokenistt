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

export type Action =
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
  if (!t.startsWith('/')) return { kind: 'search', query: t };
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
