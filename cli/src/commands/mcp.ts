import type { Command } from 'commander';
import { openDatabase } from '../store/db.js';
import { requireProject } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

export function registerMcp(program: Command, getCtx: GetCtx): void {
  program
    .command('mcp')
    .description("Serve this repository's graph, memory and sessions to agents as MCP tools, over stdio. Needs no network")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const project = requireProject(process.cwd());
      // Loaded here so the SDK is not a cost for any other command.
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const { buildMcpServer } = await import('../mcp/server.js');
      const db = openDatabase(project.repo.root);
      const server = buildMcpServer(project, db, ctx.version);
      await new Promise<void>((resolve, reject) => {
        const transport = new StdioServerTransport();
        transport.onclose = () => resolve();
        process.stdin.once('end', () => resolve());
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
        server.connect(transport).catch(reject);
      });
      await server.close();
      db.close();
    });
}
