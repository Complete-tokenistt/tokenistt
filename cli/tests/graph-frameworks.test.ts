import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tablesInSql } from '../src/graph/frameworks/sql-in-code.js';
import { extractFile } from '../src/graph/languages/index.js';
import { linkGraph } from '../src/graph/linker.js';
import type { GraphEdge, GraphNode } from '../src/graph/schema.js';

async function link(files: Record<string, string>) {
  const extracts = await Promise.all(Object.entries(files).map(([p, t]) => extractFile(p, t, 'sha', t.length)));
  return linkGraph(extracts, 'repo');
}
const routes = (nodes: GraphNode[]) => nodes.filter((n) => n.type === 'endpoint').map((n) => n.name).sort();
const has = (edges: GraphEdge[], source: string, target: string, type: string) => edges.some((e) => e.source === source && e.target === target && e.type === type);
const expectEdge = (edges: GraphEdge[], source: string, target: string, type: string) =>
  assert.ok(has(edges, source, target, type), `missing ${type}: ${source} -> ${target}\n  have: ${edges.filter((e) => e.type === type).map((e) => `${e.source} -> ${e.target}`).join('\n        ')}`);

describe('SQL in code', () => {
  it('reads tables and separates reads from writes', () => {
    assert.deepEqual(tablesInSql('SELECT * FROM users u JOIN orgs o ON o.id = u.org'), [{ table: 'users', access: 'read' }, { table: 'orgs', access: 'read' }]);
    assert.deepEqual(tablesInSql('INSERT INTO public.audit (a) SELECT a FROM users'), [{ table: 'audit', access: 'write' }, { table: 'users', access: 'read' }]);
    assert.deepEqual(tablesInSql('UPDATE users SET a = 1'), [{ table: 'users', access: 'write' }]);
    assert.deepEqual(tablesInSql('DELETE FROM users WHERE id = 1'), [{ table: 'users', access: 'write' }]);
    assert.deepEqual(tablesInSql('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2'), [{ table: 't', access: 'write' }]);
  });
  it('a table both read and written counts as written', () => {
    assert.deepEqual(tablesInSql('WITH x AS (SELECT * FROM t) INSERT INTO t SELECT * FROM x'), [{ table: 't', access: 'write' }, { table: 'x', access: 'read' }]);
  });
  it('ignores text that is not a statement', () => {
    assert.deepEqual(tablesInSql('error from the server'), []);
    assert.deepEqual(tablesInSql('Please select from users'), []);
  });
});

describe('Express', () => {
  const files = {
    'src/server.ts': `import express from 'express';
import { apiRouter } from './api';
const app = express();
app.use('/v1', apiRouter);
app.get('/health', (req, res) => { check(); res.send('ok'); });
function check() {}
`,
    'src/api.ts': `import { Router } from 'express';
import { getPool } from './db';
import { listUsers } from './users';
import admin from './admin';
export const apiRouter = Router();
apiRouter.use('/admin', admin);
apiRouter.get('/users', listUsers);
apiRouter.post('/users', async (req, res) => { const pool = getPool(); await pool.query('INSERT INTO users (a) VALUES (1)'); });
const m = new Map();
m.get('/not-a-route');
`,
    'src/admin.ts': `import { Router } from 'express';
const router = Router();
router.delete('/keys/:id', (req, res) => {});
export default router;
`,
    'src/users.ts': `import { getPool } from './db';
export async function listUsers(req, res) { return getPool().query('SELECT * FROM users'); }
export async function lookup() { const r = await db.query('SELECT * FROM not_defined_anywhere'); }
`,
    'src/db.ts': 'export function getPool() { return null; }\n',
    'db/schema.sql': 'CREATE TABLE users (id INT);\n',
  };
  it('applies nested mount prefixes and ignores lookalikes', async () => {
    const { nodes } = await link(files);
    assert.deepEqual(routes(nodes), ['DELETE /v1/admin/keys/:id', 'GET /health', 'GET /v1/users', 'POST /v1/users']);
    assert.equal(nodes.find((n) => n.name === 'GET /health')?.metadata?.framework, 'express');
  });
  it('traces a request from route to handler to table', async () => {
    const { edges } = await link(files);
    const route = 'api:src/api.ts#GET /v1/users';
    expectEdge(edges, 'sym:src/users.ts#function:listUsers', route, 'CONNECTS_TO');
    expectEdge(edges, 'sym:src/users.ts#function:listUsers', 'table:users', 'READS_FROM');
    expectEdge(edges, 'api:src/server.ts#GET /health', 'sym:src/server.ts#function:check', 'CALLS');
    expectEdge(edges, 'api:src/api.ts#POST /v1/users', 'sym:src/db.ts#function:getPool', 'CALLS');
    expectEdge(edges, 'file:src/api.ts', 'table:users', 'WRITES_TO');
  });
  it('does not invent a table the repository does not define', async () => {
    const { nodes } = await link(files);
    assert.equal(nodes.some((n) => n.name === 'not_defined_anywhere'), false);
  });
});

describe('Next.js', () => {
  const files = {
    'web/package.json': JSON.stringify({ dependencies: { next: '15', react: '19' } }),
    'web/app/page.tsx': 'export default function Home() { return <Banner />; }\nfunction Banner() { return <div />; }\n',
    'web/app/(shop)/items/[id]/page.tsx': 'export default function Item() { return <div />; }\n',
    'web/app/api/users/route.ts': 'export async function GET() {}\nexport async function POST() {}\nexport function helper() {}\n',
    'web/app/docs/[...slug]/page.tsx': 'export default function Docs() { return <div />; }\n',
    'web/pages/api/legacy/index.ts': 'export default function handler() {}\n',
    'other/app/route.ts': 'export async function GET() {}\n',
  };
  it('finds routes from the file system, only where next is a dependency', async () => {
    const { nodes } = await link(files);
    assert.deepEqual(routes(nodes), ['ANY /api/legacy', 'GET /api/users', 'PAGE /', 'PAGE /docs/*slug', 'PAGE /items/:id', 'POST /api/users']);
  });
  it('connects a route to its handler', async () => {
    const { edges } = await link(files);
    expectEdge(edges, 'sym:web/app/api/users/route.ts#function:GET', 'api:web/app/api/users/route.ts#GET /api/users', 'CONNECTS_TO');
    expectEdge(edges, 'sym:web/app/page.tsx#function:Home', 'api:web/app/page.tsx#PAGE /', 'CONNECTS_TO');
  });
});

describe('React', () => {
  it('marks components and links JSX usage', async () => {
    const { nodes, edges } = await link({
      'ui/Button.tsx': 'export function Button() { return <button />; }\nexport function formatLabel() { return "x"; }\n',
      'ui/App.tsx': "import { Button } from './Button';\nexport const App = () => <main><Button /></main>;\n",
    });
    assert.equal(nodes.find((n) => n.id === 'sym:ui/Button.tsx#function:Button')?.type, 'component');
    assert.equal(nodes.find((n) => n.id === 'sym:ui/Button.tsx#function:formatLabel')?.type, 'function');
    assert.equal(nodes.find((n) => n.id === 'sym:ui/App.tsx#function:App')?.type, 'component');
    expectEdge(edges, 'sym:ui/App.tsx#function:App', 'sym:ui/Button.tsx#function:Button', 'USES');
  });
});

describe('NestJS', () => {
  it('finds controller routes and constructor injection', async () => {
    const { nodes, edges } = await link({
      'users.service.ts': "import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class UsersService { all() {} }\n",
      'users.controller.ts': `import { Controller, Get, Post } from '@nestjs/common';
import { UsersService } from './users.service';
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get()
  list() {}
  @Post(':id/ban')
  ban() {}
  helper() {}
}
`,
    });
    assert.deepEqual(routes(nodes), ['GET /users', 'POST /users/:id/ban']);
    expectEdge(edges, 'sym:users.controller.ts#method:UsersController.list', 'api:users.controller.ts#GET /users', 'CONNECTS_TO');
    expectEdge(edges, 'sym:users.controller.ts#class:UsersController', 'sym:users.service.ts#class:UsersService', 'USES');
  });
});

describe('Drizzle, Prisma and Supabase', () => {
  it('Drizzle: tables, columns and access through an imported variable', async () => {
    const { nodes, edges } = await link({
      'db/schema.ts': "import { pgTable, text, bigint } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { id: bigint('id'), fullName: text('full_name').notNull(), plain: text() });\n",
      'db/repo.ts': "import { users } from './schema';\nexport function read() { return db.select().from(users); }\nexport function write() { return db.insert(users).values({}); }\n",
    });
    assert.ok(nodes.some((n) => n.id === 'table:users'));
    assert.ok(nodes.some((n) => n.id === 'col:users.full_name'));
    assert.ok(nodes.some((n) => n.id === 'col:users.plain'));
    expectEdge(edges, 'sym:db/repo.ts#function:read', 'table:users', 'READS_FROM');
    expectEdge(edges, 'sym:db/repo.ts#function:write', 'table:users', 'WRITES_TO');
  });
  it('Prisma: models, @@map, relations and client access', async () => {
    const { nodes, edges } = await link({
      'schema.prisma': `model User {
  id Int @id
  fullName String @map("full_name")
  posts Post[]
  @@map("app_users")
}
model Post {
  id Int @id
  author User @relation(fields: [authorId], references: [id])
  authorId Int
}
`,
      'a.ts': 'export function a() { return prisma.user.findMany(); }\nexport function b() { return prisma.post.create({}); }\n',
    });
    assert.ok(nodes.some((n) => n.id === 'col:app_users.full_name'));
    expectEdge(edges, 'table:post', 'table:app_users', 'DEPENDS_ON');
    expectEdge(edges, 'sym:a.ts#function:a', 'table:app_users', 'READS_FROM');
    expectEdge(edges, 'sym:a.ts#function:b', 'table:post', 'WRITES_TO');
  });
  it('Supabase: read and write through from()', async () => {
    const { edges } = await link({
      'supabase/migrations/1.sql': 'CREATE TABLE notes (id INT);',
      'a.ts': "export function r() { return supabase.from('notes').select(); }\nexport function w() { return supabase.from('notes').insert({}); }\nexport function u() { return supabase.from('unknown').select(); }\n",
    });
    expectEdge(edges, 'sym:a.ts#function:r', 'table:notes', 'READS_FROM');
    expectEdge(edges, 'sym:a.ts#function:w', 'table:notes', 'WRITES_TO');
    assert.equal(edges.some((e) => e.target === 'table:unknown'), false);
  });
});

describe('FastAPI and Flask', () => {
  it('FastAPI: decorators, APIRouter prefix and include_router prefix', async () => {
    const { nodes, edges } = await link({
      'main.py': 'from fastapi import FastAPI\nfrom .users import router as users_router\napp = FastAPI()\napp.include_router(users_router, prefix="/api")\n@app.get("/health")\ndef health():\n    pass\n',
      'users.py': 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/users")\n@router.get("/{id}")\nasync def get_user(id: int):\n    pass\n@router.post("/")\ndef create():\n    pass\n',
    });
    assert.deepEqual(routes(nodes), ['GET /api/users/{id}', 'GET /health', 'POST /api/users']);
    expectEdge(edges, 'sym:users.py#function:get_user', 'api:users.py#GET /api/users/{id}', 'CONNECTS_TO');
  });
  it('FastAPI: mounts a router reached through a module', async () => {
    const { nodes } = await link({
      'api/main.py': 'from fastapi import APIRouter\nfrom api import items\napi_router = APIRouter()\napi_router.include_router(items.router, prefix="/shop")\n',
      'api/items.py': 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/items")\n@router.get("/")\ndef list_items():\n    pass\n',
    });
    assert.deepEqual(routes(nodes), ['GET /shop/items']);
  });
  it('links `from pkg import submodule` and calls through it', async () => {
    const { edges } = await link({
      'pkg/__init__.py': '',
      'pkg/views.py': 'def show():\n    pass\n',
      'pkg/helpers.py': 'def assist():\n    pass\n',
      'pkg/app.py': 'from . import views\nfrom pkg import helpers as h\ndef run():\n    views.show()\n    h.assist()\n',
    });
    expectEdge(edges, 'file:pkg/app.py', 'file:pkg/views.py', 'IMPORTS');
    expectEdge(edges, 'file:pkg/app.py', 'file:pkg/helpers.py', 'IMPORTS');
    expectEdge(edges, 'sym:pkg/app.py#function:run', 'sym:pkg/views.py#function:show', 'CALLS');
    expectEdge(edges, 'sym:pkg/app.py#function:run', 'sym:pkg/helpers.py#function:assist', 'CALLS');
  });
  it('Flask: route with methods', async () => {
    const { nodes } = await link({
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n@app.route("/a")\ndef a():\n    pass\n@app.route("/b", methods=["POST", "PUT"])\ndef b():\n    pass\n@app.get("/c")\ndef c():\n    pass\n',
    });
    assert.deepEqual(routes(nodes), ['GET /a', 'GET /c', 'POST /b', 'PUT /b']);
    assert.equal(nodes.find((n) => n.name === 'GET /c')?.metadata?.framework, 'flask');
  });
  it('raw SQL in Python links to defined tables', async () => {
    const { edges } = await link({ 's.sql': 'CREATE TABLE t (a INT);', 'a.py': 'def go(cur):\n    cur.execute("UPDATE t SET a = 1")\n' });
    expectEdge(edges, 'sym:a.py#function:go', 'table:t', 'WRITES_TO');
  });
});

describe('Django', () => {
  it('finds urls, models and ORM access', async () => {
    const { nodes, edges } = await link({
      'shop/models.py': 'from django.db import models\nclass Order(models.Model):\n    total = models.IntegerField()\n    class Meta:\n        db_table = "orders"\nclass Item(models.Model):\n    name = models.CharField(max_length=9)\n',
      'shop/views.py': 'from .models import Order, Item\ndef list_orders(request):\n    return Order.objects.filter(total=1)\ndef add(request):\n    return Item.objects.create(name="x")\n',
      'shop/urls.py': 'from django.urls import path, include\nfrom . import views\nurlpatterns = [path("orders/", views.list_orders), path("sub/", include("x.urls"))]\n',
    });
    assert.ok(nodes.some((n) => n.id === 'col:orders.total'));
    assert.ok(nodes.some((n) => n.id === 'table:shop_item'), 'default table name is <app>_<model>');
    assert.deepEqual(routes(nodes), ['ANY /orders']);
    expectEdge(edges, 'sym:shop/views.py#function:list_orders', 'table:orders', 'READS_FROM');
    expectEdge(edges, 'sym:shop/views.py#function:add', 'table:shop_item', 'WRITES_TO');
  });
});

describe('Spring Boot', () => {
  it('finds controller routes, injection and entities', async () => {
    const { nodes, edges } = await link({
      'src/User.java': 'package a; import jakarta.persistence.*; @Entity @Table(name = "app_users") public class User { @Id private Long id; @Column(name = "full_name") private String name; }',
      'src/UserService.java': 'package a; public class UserService {}',
      'src/AuditService.java': 'package a; public class AuditService {}',
      'src/UserController.java': `package a;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/users")
public class UserController {
  @Autowired private AuditService audit;
  public UserController(UserService service) {}
  @GetMapping("/{id}") public String one() { return ""; }
  @PostMapping public String add() { return ""; }
  public String notARoute() { return ""; }
}`,
    });
    assert.deepEqual(routes(nodes), ['GET /users/{id}', 'POST /users']);
    assert.ok(nodes.some((n) => n.id === 'col:app_users.full_name'));
    expectEdge(edges, 'sym:src/UserController.java#method:UserController.one', 'api:src/UserController.java#GET /users/{id}', 'CONNECTS_TO');
    expectEdge(edges, 'sym:src/UserController.java#class:UserController', 'sym:src/UserService.java#class:UserService', 'USES');
    expectEdge(edges, 'sym:src/UserController.java#class:UserController', 'sym:src/AuditService.java#class:AuditService', 'USES');
  });
});

describe('Node.js entry points', () => {
  it('marks the file a package points at, including built output mapped back to source', async () => {
    const { nodes } = await link({
      'a/package.json': JSON.stringify({ name: 'a', main: 'dist/index.js' }),
      'a/src/index.ts': 'export const x = 1;',
      'a/src/other.ts': 'export const y = 1;',
    });
    assert.equal(nodes.find((n) => n.id === 'file:a/src/index.ts')?.metadata?.entryPoint, true);
    assert.equal(nodes.find((n) => n.id === 'file:a/src/other.ts')?.metadata?.entryPoint, undefined);
  });
});
