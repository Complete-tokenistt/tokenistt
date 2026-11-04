/** The terminal dashboard. It only displays what it is given, so it can be tested with plain data and no terminal. */
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import type { DashboardData } from './data.js';
import { formatDuration } from './format.js';

export const TABS = ['Overview', 'Agents', 'Sessions', 'Codebase', 'Graph', 'Memory', 'Costs', 'Policies', 'Settings'] as const;
export type Tab = (typeof TABS)[number];

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const sum = (o: Record<string, number> | undefined): number => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const tokens = (n: number | null | undefined): string => (n === null || n === undefined ? 'unknown' : n.toLocaleString('en-US'));
const usd = (n: number | null): string => (n === null ? 'unknown' : `~$${n.toFixed(4)} estimated`);

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <Box flexShrink={0}>
      <Box width={16} flexShrink={0}><Text dimColor>{label}</Text></Box>
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  );
}

function Heading({ children }: { children: ReactNode }): ReactNode {
  return <Box marginTop={1} flexShrink={0}><Text bold>{children}</Text></Box>;
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return <Text dimColor>{children}</Text>;
}

function Overview({ d, wide }: { d: DashboardData; wide: boolean }): ReactNode {
  const active = d.sessions.filter((s) => s.state === 'active').length;
  const known = d.sessions.filter((s) => s.tokens);
  const allKnown = known.length === d.sessions.length && d.sessions.length > 0;
  return (
    <Box flexDirection={wide ? 'row' : 'column'} flexShrink={0}>
      <Box flexDirection="column" flexShrink={0} width={wide ? '50%' : undefined}>
      <Heading>Project</Heading>
      <Row label="Repository">{d.project.name}</Row>
      <Row label="Branch">{d.project.branch ?? 'none'}</Row>
      <Row label="Last commit">{d.project.commit ? `${d.project.commit} ${d.project.subject ?? ''}` : 'none yet'}</Row>
      <Heading>Agent activity</Heading>
      {d.agents.map((a) => <Row key={a.id} label={a.name}>{a.state === 'active' ? '● ' : a.state === 'not connected' ? '○ ' : '◌ '}{a.state}</Row>)}
      <Heading>Codebase</Heading>
      {d.graph ? (
        <>
          <Row label="Files indexed">{d.graph.files.total}</Row>
          <Row label="Nodes">{sum(d.graph.nodes)}</Row>
          <Row label="Relationships">{sum(d.graph.edges)}</Row>
          <Row label="Updated">{d.graph.generatedAt}</Row>
        </>
      ) : <Empty>Not indexed yet. Run tokenistt map.</Empty>}
      </Box>
      <Box flexDirection="column" flexShrink={0} width={wide ? '50%' : undefined}>
      <Heading>Sessions</Heading>
      <Row label="Active">{active}</Row>
      <Row label="Recorded">{d.sessions.length}</Row>
      <Row label="Total tokens">{allKnown ? tokens(known.reduce((t, s) => t + (s.tokens?.total ?? 0), 0)) : d.sessions.length ? 'unknown for some sessions' : 'none'}</Row>
      <Heading>Memory</Heading>
      <Row label="Entries">{d.memory.active} active, {d.memory.stale} stale</Row>
      <Row label="Decisions">{d.memory.byCategory.ARCHITECTURAL_DECISIONS ?? 0}</Row>
      <Row label="Open tasks">{d.memory.byCategory.OPEN_TASKS ?? 0}</Row>
      <Row label="Updated">{d.memory.lastUpdated ?? 'never'}</Row>
      <Heading>Status</Heading>
      <Row label="Gateway">{d.gateway.state}{d.gateway.url ? ` (${d.gateway.url})` : ''}</Row>
      <Row label="Local storage">{d.project.root}</Row>
      <Row label="Sync">{d.project.syncEnabled ? 'on' : 'off'}</Row>
      </Box>
    </Box>
  );
}

function Agents({ d }: { d: DashboardData }): ReactNode {
  return (
    <Box flexDirection="column">
      {d.agents.map((a) => (
        <Box key={a.id} flexDirection="column" marginTop={1}>
          <Text bold>{a.name}</Text>
          <Row label="State">{a.state}</Row>
          <Row label="Installed">{a.installed ? 'yes' : 'not found'}</Row>
          <Row label="Checked">{a.verification === 'live' ? 'against the real agent' : 'from its documentation only'}</Row>
          {!a.connected ? <Empty>Connect with: tokenistt agents connect {a.id}</Empty> : null}
        </Box>
      ))}
    </Box>
  );
}

function Sessions({ d, selected }: { d: DashboardData; selected: number }): ReactNode {
  if (!d.sessions.length) return <Box marginTop={1}><Empty>No sessions recorded yet. Connect an agent with tokenistt agents connect.</Empty></Box>;
  const s = d.sessions[Math.min(selected, d.sessions.length - 1)];
  return (
    <Box flexDirection="column" marginTop={1}>
      {d.sessions.slice(0, 8).map((x, i) => (
        <Text key={x.key} inverse={i === selected} wrap="truncate-end">
          {`${x.id.slice(0, 8)}  ${x.agent.padEnd(12)} ${x.state.padEnd(9)} ${formatDuration(x.durationMs).padStart(8)}  tokens ${tokens(x.tokens?.total ?? null)}`}
        </Text>
      ))}
      {s ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{s.id}</Text>
          <Row label="Branch">{s.branch ?? 'unknown'}</Row>
          <Row label="Model">{s.models.join(', ') || 'unknown'}</Row>
          <Row label="Cost">{usd(s.cost.costUsd)}</Row>
          <Row label="Changed">{[...s.files.created, ...s.files.modified, ...s.files.deleted].slice(0, 6).join(', ') || 'nothing'}</Row>
          <Row label="Errors">{s.counts.errors}</Row>
          <Row label="Tests">{s.counts.testsPassed} passed, {s.counts.testsFailed} failed{s.counts.testsUnknown ? `, ${s.counts.testsUnknown} unknown` : ''}</Row>
        </Box>
      ) : null}
    </Box>
  );
}

function Codebase({ d }: { d: DashboardData }): ReactNode {
  if (!d.graph) return <Box marginTop={1}><Empty>Not indexed yet. Run tokenistt map.</Empty></Box>;
  return (
    <Box flexDirection="column">
      <Heading>Nodes</Heading>
      {Object.entries(d.graph.nodes).map(([k, v]) => <Row key={k} label={k}>{v}</Row>)}
      <Heading>Languages</Heading>
      <Text wrap="wrap">{Object.entries(d.graph.languages).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}</Text>
    </Box>
  );
}

function Graph({ d }: { d: DashboardData }): ReactNode {
  if (!d.graph) return <Box marginTop={1}><Empty>Not indexed yet. Run tokenistt map.</Empty></Box>;
  return (
    <Box flexDirection="column">
      <Heading>Largest areas</Heading>
      {d.largest.map((a) => <Row key={a.name} label={String(a.nodes)}>{a.name}</Row>)}
      <Heading>Most depended on</Heading>
      {d.mostUsed.map((a) => <Row key={`${a.path}${a.name}`} label={String(a.dependents)}>{a.name}{a.path ? `  ${a.path}` : ''}</Row>)}
      <Box marginTop={1}><Empty>Explore all of it with tokenistt graph --open.</Empty></Box>
    </Box>
  );
}

function MemoryTab({ d }: { d: DashboardData }): ReactNode {
  if (!d.memories.length) return <Box marginTop={1}><Empty>Nothing remembered yet. Run tokenistt memory update.</Empty></Box>;
  return (
    <Box flexDirection="column" marginTop={1}>
      {d.memories.slice(0, 14).map((m) => (
        <Text key={m.id} wrap="truncate-end">{m.status === 'stale' ? '? ' : '  '}{m.content}</Text>
      ))}
      <Box marginTop={1}><Empty>? means it may be out of date. See sources with tokenistt memory show.</Empty></Box>
    </Box>
  );
}

function Costs({ d }: { d: DashboardData }): ReactNode {
  return (
    <Box flexDirection="column">
      <Heading>By agent</Heading>
      {d.costs.map((c) => <Row key={c.agent} label={c.agent}>{`${c.sessions} sessions, tokens ${c.sessions ? tokens(c.tokens) : 'none'}, cost ${c.sessions ? usd(c.costUsd) : 'none'}`}</Row>)}
      <Box marginTop={1}><Empty>Estimates are tokens times catalog prices, not your bill. On a subscription they are not spend at all.</Empty></Box>
    </Box>
  );
}

function Policies({ d }: { d: DashboardData }): ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Policies are enforced by your gateway, which is {d.gateway.state}.</Text>
      <Empty>{d.gateway.state === 'connected' ? 'Manage them with tokenistt policy, or in the dashboard.' : 'Connect with tokenistt login.'}</Empty>
    </Box>
  );
}

function Settings({ d }: { d: DashboardData }): ReactNode {
  return (
    <Box flexDirection="column">
      <Heading>This repository</Heading>
      <Row label="Project id">{d.project.id}</Row>
      <Row label="Commands kept">{d.project.privacy}</Row>
      <Row label="Prompts kept">{d.project.capturePrompts ? 'yes' : 'no'}</Row>
      <Row label="Sync">{d.project.syncEnabled ? 'on' : 'off'}</Row>
      <Box marginTop={1}><Empty>Change these in .tokenistt/config.json.</Empty></Box>
    </Box>
  );
}

export interface AppProps {
  data: DashboardData;
  motion: boolean;
  initialTab?: Tab;
  /** Fetches fresh data; absent in tests that want a fixed screen. */
  reload?: () => Promise<DashboardData>;
  reloadMs?: number;
}

export function App({ data, motion, initialTab = 'Overview', reload, reloadMs = 2000 }: AppProps): ReactNode {
  const [d, setD] = useState(data);
  const [tab, setTab] = useState<number>(TABS.indexOf(initialTab));
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [frame, setFrame] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });

  useEffect(() => {
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  useEffect(() => {
    if (!reload) return undefined;
    const timer = setInterval(() => {
      setRefreshing(true);
      void reload().then(setD).catch(() => undefined).finally(() => setRefreshing(false));
    }, reloadMs);
    return () => clearInterval(timer);
  }, [reload, reloadMs]);

  useEffect(() => {
    if (!motion || !refreshing) return undefined;
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [motion, refreshing]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) exit();
    else if (key.rightArrow || key.tab) { setTab((t) => (t + 1) % TABS.length); setSelected(0); setScroll(0); }
    else if (key.leftArrow) { setTab((t) => (t - 1 + TABS.length) % TABS.length); setSelected(0); setScroll(0); }
    else if (/^[1-9]$/.test(input)) { setTab(Number(input) - 1); setSelected(0); setScroll(0); }
    else if (key.downArrow) {
      if (TABS[tab] === 'Sessions') setSelected((s) => Math.min(s + 1, Math.max(0, Math.min(d.sessions.length, 8) - 1)));
      else setScroll((s) => Math.min(s + 1, 60));
    } else if (key.upArrow) {
      if (TABS[tab] === 'Sessions') setSelected((s) => Math.max(0, s - 1));
      else setScroll((s) => Math.max(0, s - 1));
    }
  });

  const current = TABS[tab] ?? 'Overview';
  const narrow = size.columns < 90;
  return (
    <Box flexDirection="column" width={size.columns} height={Math.max(8, size.rows - 1)} overflow="hidden">
      <Box>
        <Text bold>Tokenistt</Text>
        <Text dimColor>{`  ${d.project.name}${d.project.branch ? ` on ${d.project.branch}` : ''}`}</Text>
        {refreshing && motion ? <Text dimColor>{`  ${FRAMES[frame]}`}</Text> : null}
      </Box>
      <Box>
        <Text wrap="truncate-end">
          {narrow
            ? `${tab + 1}/${TABS.length} ${current}`
            : TABS.map((t, i) => (i === tab ? `[${i + 1} ${t}]` : ` ${i + 1} ${t} `)).join('')}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box flexDirection="column" flexShrink={0} marginTop={-scroll}>
        {current === 'Overview' ? <Overview d={d} wide={!narrow} /> : null}
        {current === 'Agents' ? <Agents d={d} /> : null}
        {current === 'Sessions' ? <Sessions d={d} selected={selected} /> : null}
        {current === 'Codebase' ? <Codebase d={d} /> : null}
        {current === 'Graph' ? <Graph d={d} /> : null}
        {current === 'Memory' ? <MemoryTab d={d} /> : null}
        {current === 'Costs' ? <Costs d={d} /> : null}
        {current === 'Policies' ? <Policies d={d} /> : null}
        {current === 'Settings' ? <Settings d={d} /> : null}
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">Left and right or 1-9: switch. Up and down: select or scroll. q: quit.</Text>
    </Box>
  );
}
