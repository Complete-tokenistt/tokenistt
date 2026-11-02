/** One small multi-file project per language, asserting exact symbols and edges. A language is only claimed in docs once it passes here. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFile } from '../src/graph/languages/index.js';
import { linkGraph } from '../src/graph/linker.js';
import type { FileExtract, GraphEdge } from '../src/graph/schema.js';

const x = (path: string, text: string): Promise<FileExtract> => extractFile(path, text, 'sha', text.length);
const names = (e: FileExtract) => e.symbols.map((s) => `${s.kind}:${s.qualified}${s.exported ? '*' : ''}`).sort();

async function link(files: Record<string, string>) {
  const extracts = await Promise.all(Object.entries(files).map(([p, t]) => x(p, t)));
  for (const e of extracts) assert.equal(e.parseErrors, false, `${e.path} parsed with errors`);
  return linkGraph(extracts, 'repo');
}
const has = (edges: GraphEdge[], source: string, target: string, type: string) => edges.some((e) => e.source === source && e.target === target && e.type === type);
const expectEdge = (edges: GraphEdge[], source: string, target: string, type: string) =>
  assert.ok(has(edges, source, target, type), `missing ${type}: ${source} -> ${target}\n  have: ${edges.filter((e) => e.type === type).map((e) => `${e.source} -> ${e.target}`).join('\n        ')}`);

describe('Java', () => {
  const files = {
    'pom.xml': '<project><parent><artifactId>parent</artifactId></parent><artifactId>demo</artifactId><dependencies><dependency><groupId>org.junit</groupId><artifactId>junit</artifactId><scope>test</scope></dependency></dependencies></project>',
    'src/main/java/com/acme/db/Repo.java': 'package com.acme.db; public class Repo { public static Repo make() { return null; } public void save() {} }',
    'src/main/java/com/acme/svc/Base.java': 'package com.acme.svc; abstract class Base {}',
    'src/main/java/com/acme/svc/Thing.java': 'package com.acme.svc; public interface Thing { void go(); }',
    'src/main/java/com/acme/svc/Helper.java': 'package com.acme.svc; class Helper { static void assist() {} }',
    'src/main/java/com/acme/svc/Service.java': `package com.acme.svc;
import com.acme.db.Repo;
import java.util.List;
public class Service extends Base implements Thing {
  public Service() {}
  public void go() { this.step(); step(); Repo.make(); new Repo(); Helper.assist(); System.getenv("DB_URL"); }
  private void step() {}
}`,
  };
  it('extracts symbols with export flags', async () => {
    const e = await x('S.java', 'package a; public class S { public void m() {} void n() {} } interface I {} record R(int a) {} enum E { A }');
    assert.deepEqual(names(e), ['class:E', 'class:R', 'class:S*', 'interface:I', 'method:S.m*', 'method:S.n'].sort());
    assert.equal(e.namespace, 'a');
  });
  it('links imports, same-package names, heritage, calls and env vars', async () => {
    const { edges, nodes } = await link(files);
    const svc = 'file:src/main/java/com/acme/svc/Service.java';
    const go = 'sym:src/main/java/com/acme/svc/Service.java#method:Service.go';
    expectEdge(edges, svc, 'file:src/main/java/com/acme/db/Repo.java', 'IMPORTS');
    expectEdge(edges, svc, 'pkg:java.util', 'IMPORTS');
    expectEdge(edges, 'sym:src/main/java/com/acme/svc/Service.java#class:Service', 'sym:src/main/java/com/acme/svc/Base.java#class:Base', 'EXTENDS');
    expectEdge(edges, 'sym:src/main/java/com/acme/svc/Service.java#class:Service', 'sym:src/main/java/com/acme/svc/Thing.java#interface:Thing', 'IMPLEMENTS');
    expectEdge(edges, go, 'sym:src/main/java/com/acme/svc/Service.java#method:Service.step', 'CALLS');
    expectEdge(edges, go, 'sym:src/main/java/com/acme/db/Repo.java#method:Repo.make', 'CALLS');
    expectEdge(edges, go, 'sym:src/main/java/com/acme/db/Repo.java#class:Repo', 'CALLS');
    expectEdge(edges, go, 'sym:src/main/java/com/acme/svc/Helper.java#method:Helper.assist', 'CALLS');
    expectEdge(edges, go, 'env:DB_URL', 'USES');
    assert.equal(nodes.find((n) => n.id === 'module:.')?.name, 'demo');
    expectEdge(edges, 'module:.', 'pkg:org.junit:junit', 'DEPENDS_ON');
  });
  it('resolves wildcard imports through an open scope', async () => {
    const { edges } = await link({
      'src/com/acme/db/Repo.java': 'package com.acme.db; public class Repo { public static void make() {} }',
      'src/com/acme/App.java': 'package com.acme; import com.acme.db.*; class App { void r() { Repo.make(); } }',
    });
    expectEdge(edges, 'sym:src/com/acme/App.java#method:App.r', 'sym:src/com/acme/db/Repo.java#method:Repo.make', 'CALLS');
    expectEdge(edges, 'file:src/com/acme/App.java', 'file:src/com/acme/db/Repo.java', 'IMPORTS');
  });
});

describe('Go', () => {
  const files = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/lib/pq v1.0.0 // indirect\n)\nrequire golang.org/x/sync v0.1.0\n',
    'db/db.go': 'package db\nfunc Open() *Conn { return nil }\ntype Conn struct{}\nfunc (c *Conn) Query() { c.prepare() }\nfunc (c *Conn) prepare() {}\n',
    'db/extra.go': 'package db\nfunc Other() {}\n',
    'main.go': `package main
import (
  "fmt"
  "os"
  store "example.com/app/db"
  "github.com/lib/pq"
  _ "example.com/app/db"
)
type Runner interface { Run() }
func main() { helper(); store.Other(); store.Open(); fmt.Println(os.Getenv("PORT")); _ = pq.Foo }
func helper() {}
`,
    'util.go': 'package main\nfunc shared() {}\n',
    'more.go': 'package main\nfunc caller() { shared() }\n',
    'db/db_test.go': 'package db\nfunc TestOpen() { Open() }\n',
  };
  it('extracts symbols; capitalised means exported; methods carry the receiver', async () => {
    const e = await x('a.go', 'package a\ntype S struct{}\ntype I interface{ M() }\ntype N int\nfunc (s *S) Run() {}\nfunc (s S) low() {}\nfunc F() {}\nfunc g() {}\n');
    assert.deepEqual(names(e), ['class:S*', 'function:F*', 'function:g', 'interface:I*', 'method:S.Run*', 'method:S.low', 'type:N*'].sort());
  });
  it('links packages across files, same-package names, receivers, tests and env vars', async () => {
    const { edges, nodes } = await link(files);
    expectEdge(edges, 'file:main.go', 'file:db/db.go', 'IMPORTS');
    expectEdge(edges, 'file:main.go', 'file:db/extra.go', 'IMPORTS');
    expectEdge(edges, 'file:main.go', 'pkg:fmt', 'IMPORTS');
    expectEdge(edges, 'file:main.go', 'pkg:github.com/lib/pq', 'IMPORTS');
    assert.equal(has(edges, 'file:main.go', 'file:db/db_test.go', 'IMPORTS'), false, 'a package import does not include its tests');
    expectEdge(edges, 'sym:main.go#function:main', 'sym:db/extra.go#function:Other', 'CALLS');
    expectEdge(edges, 'sym:main.go#function:main', 'sym:db/db.go#function:Open', 'CALLS');
    expectEdge(edges, 'sym:main.go#function:main', 'sym:main.go#function:helper', 'CALLS');
    expectEdge(edges, 'sym:more.go#function:caller', 'sym:util.go#function:shared', 'CALLS');
    expectEdge(edges, 'sym:db/db.go#method:Conn.Query', 'sym:db/db.go#method:Conn.prepare', 'CALLS');
    expectEdge(edges, 'sym:main.go#function:main', 'env:PORT', 'USES');
    expectEdge(edges, 'test:db/db_test.go', 'file:db/db.go', 'TESTS');
    assert.equal(nodes.find((n) => n.id === 'module:.')?.name, 'example.com/app');
    expectEdge(edges, 'module:.', 'pkg:golang.org/x/sync', 'DEPENDS_ON');
    expectEdge(edges, 'module:.', 'pkg:github.com/lib/pq', 'DEPENDS_ON');
  });
});

describe('Rust', () => {
  const files = {
    'Cargo.toml': '[package]\nname = "demo"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n\n[dev-dependencies]\nproptest = "1"\n',
    'src/main.rs': `mod db;
mod svc;
use crate::db::{Conn, open as start};
use crate::svc::Runner;
use std::env;
use serde::Serialize;
fn main() { helper(); start(); Conn::new(); db::open(); env::var("HOME"); std::env::var("PATH"); let _ = env!("BUILD"); }
fn helper() {}
`,
    'src/db/mod.rs': 'pub struct Conn;\nimpl Conn { pub fn new() -> Self { Self::init() } fn init() -> Self { Conn } pub fn q(&self) { self.p(); } fn p(&self) {} }\npub fn open() {}\n',
    'src/svc.rs': 'use super::db::Conn;\npub trait Runner { fn run(&self); }\npub struct S;\nimpl Runner for S { fn run(&self) { Conn::new(); } }\n',
  };
  it('extracts symbols; pub means exported; impl qualifies methods', async () => {
    const e = await x('a.rs', 'pub struct S;\nenum E { A }\npub trait T { fn m(&self); }\nimpl S { pub fn a(&self) {} }\npub fn f() {}\nfn g() {}\ntype A = i32;\n');
    assert.deepEqual(names(e), ['class:E', 'class:S*', 'function:f*', 'function:g', 'interface:T*', 'method:S.a*', 'method:T.m', 'type:A'].sort());
  });
  it('links use trees, mod files, super, impl traits and env vars', async () => {
    const { edges, nodes } = await link(files);
    expectEdge(edges, 'file:src/main.rs', 'file:src/db/mod.rs', 'IMPORTS');
    expectEdge(edges, 'file:src/main.rs', 'file:src/svc.rs', 'IMPORTS');
    expectEdge(edges, 'file:src/svc.rs', 'file:src/db/mod.rs', 'IMPORTS');
    expectEdge(edges, 'file:src/main.rs', 'pkg:std', 'IMPORTS');
    expectEdge(edges, 'file:src/main.rs', 'pkg:serde', 'IMPORTS');
    const main = 'sym:src/main.rs#function:main';
    expectEdge(edges, main, 'sym:src/main.rs#function:helper', 'CALLS');
    expectEdge(edges, main, 'sym:src/db/mod.rs#function:open', 'CALLS');
    expectEdge(edges, main, 'sym:src/db/mod.rs#method:Conn.new', 'CALLS');
    expectEdge(edges, 'sym:src/db/mod.rs#method:Conn.new', 'sym:src/db/mod.rs#method:Conn.init', 'CALLS');
    expectEdge(edges, 'sym:src/db/mod.rs#method:Conn.q', 'sym:src/db/mod.rs#method:Conn.p', 'CALLS');
    expectEdge(edges, 'sym:src/svc.rs#class:S', 'sym:src/svc.rs#interface:Runner', 'IMPLEMENTS');
    expectEdge(edges, 'sym:src/svc.rs#method:S.run', 'sym:src/db/mod.rs#method:Conn.new', 'CALLS');
    for (const v of ['HOME', 'PATH', 'BUILD']) expectEdge(edges, main, `env:${v}`, 'USES');
    assert.equal(nodes.find((n) => n.id === 'module:.')?.name, 'demo');
    expectEdge(edges, 'module:.', 'pkg:tokio', 'DEPENDS_ON');
    expectEdge(edges, 'module:.', 'pkg:proptest', 'DEPENDS_ON');
  });
});

describe('Rust crate roots', () => {
  it('finds a crate root outside src/', async () => {
    const { edges, stats } = await link({
      'Cargo.toml': '[package]\nname = "demo"\n[[bin]]\npath = "crates/core/main.rs"\n',
      'crates/core/main.rs': 'mod flags;\nuse crate::flags::parse;\nfn main() { parse(); }\n',
      'crates/core/flags/mod.rs': 'pub mod inner;\npub fn parse() { inner::go(); }\n',
      'crates/core/flags/inner.rs': 'use crate::flags::parse;\npub fn go() {}\n',
    });
    expectEdge(edges, 'file:crates/core/main.rs', 'file:crates/core/flags/mod.rs', 'IMPORTS');
    expectEdge(edges, 'file:crates/core/flags/inner.rs', 'file:crates/core/flags/mod.rs', 'IMPORTS');
    expectEdge(edges, 'sym:crates/core/main.rs#function:main', 'sym:crates/core/flags/mod.rs#function:parse', 'CALLS');
    assert.equal(stats.importsUnresolved, 0);
  });
});

describe('PHP', () => {
  const files = {
    'composer.json': JSON.stringify({ name: 'acme/app', require: { php: '>=8', 'ext-json': '*', 'monolog/monolog': '3' }, 'require-dev': { 'phpunit/phpunit': '10' } }),
    'src/Db/Repo.php': '<?php\nnamespace App\\Db;\nclass Repo { public static function make() {} public function save() { $this->check(); } private function check() {} }\n',
    'src/Contract.php': '<?php\nnamespace App;\ninterface Contract {}\n',
    'src/Base.php': '<?php\nnamespace App;\nabstract class Base {}\n',
    'src/lib.php': '<?php\nfunction assist() {}\n',
    'src/Svc.php': `<?php
namespace App;
use App\\Db\\Repo as R;
use Monolog\\Logger;
require_once 'lib.php';
class Svc extends Base implements Contract {
  public function run() { assist(); R::make(); new R(); getenv('API_KEY'); $_ENV['MODE']; }
}
`,
  };
  it('extracts symbols with visibility', async () => {
    const e = await x('a.php', '<?php\nclass C { public function a() {} private function b() {} function c() {} }\ninterface I {}\ntrait T {}\nfunction f() {}\n');
    assert.deepEqual(names(e), ['class:C*', 'class:T*', 'function:f*', 'interface:I*', 'method:C.a*', 'method:C.b', 'method:C.c*'].sort());
  });
  it('links namespaces by path, require, same-directory names, heritage and env vars', async () => {
    const { edges, nodes } = await link(files);
    expectEdge(edges, 'file:src/Svc.php', 'file:src/Db/Repo.php', 'IMPORTS');
    expectEdge(edges, 'file:src/Svc.php', 'file:src/lib.php', 'IMPORTS');
    expectEdge(edges, 'file:src/Svc.php', 'pkg:Monolog', 'IMPORTS');
    const run = 'sym:src/Svc.php#method:Svc.run';
    expectEdge(edges, 'sym:src/Svc.php#class:Svc', 'sym:src/Base.php#class:Base', 'EXTENDS');
    expectEdge(edges, 'sym:src/Svc.php#class:Svc', 'sym:src/Contract.php#interface:Contract', 'IMPLEMENTS');
    expectEdge(edges, run, 'sym:src/lib.php#function:assist', 'CALLS');
    expectEdge(edges, run, 'sym:src/Db/Repo.php#method:Repo.make', 'CALLS');
    expectEdge(edges, run, 'sym:src/Db/Repo.php#class:Repo', 'CALLS');
    expectEdge(edges, 'sym:src/Db/Repo.php#method:Repo.save', 'sym:src/Db/Repo.php#method:Repo.check', 'CALLS');
    for (const v of ['API_KEY', 'MODE']) expectEdge(edges, run, `env:${v}`, 'USES');
    assert.equal(nodes.find((n) => n.id === 'module:.')?.name, 'acme/app');
    expectEdge(edges, 'module:.', 'pkg:monolog/monolog', 'DEPENDS_ON');
    assert.equal(has(edges, 'module:.', 'pkg:php', 'DEPENDS_ON'), false);
  });
});

describe('C#', () => {
  const files = {
    'App.csproj': '<Project><ItemGroup><PackageReference Include="Serilog" Version="3" /></ItemGroup></Project>',
    'Db/Repo.cs': 'namespace Acme.Db { public class Repo { public static Repo Make() { return null; } public void Save() { Check(); } private void Check() {} } }',
    'Svc/IThing.cs': 'namespace Acme.Svc { public interface IThing {} }',
    'Svc/Base.cs': 'namespace Acme.Svc { public abstract class Base {} }',
    'Svc/Service.cs': `using System;
using Acme.Db;
namespace Acme.Svc {
  public class Service : Base, IThing {
    public void Go() { Step(); this.Step(); Repo.Make(); new Repo(); Environment.GetEnvironmentVariable("CONN"); }
    private void Step() {}
  }
}`,
  };
  it('extracts symbols with visibility', async () => {
    const e = await x('a.cs', 'namespace N { public class C { public void M() {} void P() {} } interface I {} public struct S {} public record R(int A); enum E { X } }');
    assert.deepEqual(names(e), ['class:C*', 'class:E', 'class:R*', 'class:S*', 'interface:I', 'method:C.M*', 'method:C.P'].sort());
    assert.equal(e.namespace, 'N');
  });
  it('reads file-scoped namespaces', async () => {
    const e = await x('a.cs', 'namespace N.M;\npublic class C {}\n');
    assert.equal(e.namespace, 'N.M');
    assert.deepEqual(names(e), ['class:C*']);
  });
  it('links usings only where a name is actually used', async () => {
    const { edges } = await link({ ...files, 'Db/Unused.cs': 'namespace Acme.Db { public class Unused {} }' });
    const go = 'sym:Svc/Service.cs#method:Service.Go';
    expectEdge(edges, 'sym:Svc/Service.cs#class:Service', 'sym:Svc/Base.cs#class:Base', 'EXTENDS');
    expectEdge(edges, 'sym:Svc/Service.cs#class:Service', 'sym:Svc/IThing.cs#interface:IThing', 'IMPLEMENTS');
    expectEdge(edges, go, 'sym:Svc/Service.cs#method:Service.Step', 'CALLS');
    expectEdge(edges, go, 'sym:Db/Repo.cs#method:Repo.Make', 'CALLS');
    expectEdge(edges, go, 'sym:Db/Repo.cs#class:Repo', 'CALLS');
    expectEdge(edges, go, 'env:CONN', 'USES');
    expectEdge(edges, 'file:Svc/Service.cs', 'file:Db/Repo.cs', 'IMPORTS');
    expectEdge(edges, 'file:Svc/Service.cs', 'pkg:System', 'IMPORTS');
    assert.equal(has(edges, 'file:Svc/Service.cs', 'file:Db/Unused.cs', 'IMPORTS'), false);
    expectEdge(edges, 'module:.', 'pkg:Serilog', 'DEPENDS_ON');
  });
});

describe('C and C++', () => {
  it('extracts C functions, structs and typedefs; static is not exported', async () => {
    const e = await x('a.c', 'struct P { int a; };\ntypedef struct { int b; } Q;\nenum Color { RED };\nstatic int s(void) { return 0; }\nint *f(int a) { return 0; }\nint proto(void);\nint value;\nstruct P *use(struct P *p) { return p; }\n');
    assert.deepEqual(names(e), ['class:P*', 'function:f*', 'function:proto*', 'function:s', 'function:use*', 'type:Color*', 'type:Q*'].sort());
  });
  it('links includes, prototypes and env vars', async () => {
    const { edges } = await link({
      'include/util.h': 'int util_add(int a, int b);\n',
      'src/util.c': '#include "../include/util.h"\nint util_add(int a, int b) { return a + b; }\n',
      'src/main.c': '#include "util.h"\n#include <stdio.h>\n#include <stdlib.h>\nstatic int local(void) { return 1; }\nint main(void) { local(); util_add(1, 2); puts(getenv("HOME")); return 0; }\n',
    });
    expectEdge(edges, 'file:src/main.c', 'file:include/util.h', 'IMPORTS');
    expectEdge(edges, 'file:src/util.c', 'file:include/util.h', 'IMPORTS');
    expectEdge(edges, 'file:src/main.c', 'pkg:stdio.h', 'IMPORTS');
    expectEdge(edges, 'sym:src/main.c#function:main', 'sym:src/main.c#function:local', 'CALLS');
    expectEdge(edges, 'sym:src/main.c#function:main', 'sym:include/util.h#function:util_add', 'CALLS');
    expectEdge(edges, 'sym:src/main.c#function:main', 'env:HOME', 'USES');
  });
  it('handles C++ classes, inheritance, out-of-line methods and namespaces', async () => {
    const { edges } = await link({
      'base.hpp': 'namespace n { class Base {}; class Other {}; }\n',
      'a.hpp': '#include "base.hpp"\nnamespace n { class A : public Base, private Other { public: void m(); int i() { return 1; } }; }\nvoid free_fn();\n',
      'a.cpp': '#include "a.hpp"\nvoid A::m() { this->i(); i(); free_fn(); auto v = std::getenv("HOME"); }\nvoid free_fn() {}\n',
    });
    expectEdge(edges, 'sym:a.hpp#class:A', 'sym:base.hpp#class:Base', 'EXTENDS');
    expectEdge(edges, 'sym:a.hpp#class:A', 'sym:base.hpp#class:Other', 'EXTENDS');
    expectEdge(edges, 'file:a.cpp', 'file:a.hpp', 'IMPORTS');
    expectEdge(edges, 'sym:a.cpp#method:A.m', 'sym:a.cpp#function:free_fn', 'CALLS');
    expectEdge(edges, 'sym:a.cpp#method:A.m', 'env:HOME', 'USES');
  });
  it('does not guess when two included headers declare the same name', async () => {
    const { edges } = await link({
      'x.h': 'void same(void);\n',
      'y.h': 'void same(void);\n',
      'm.c': '#include "x.h"\n#include "y.h"\nvoid run(void) { same(); }\n',
    });
    assert.equal(edges.filter((e) => e.type === 'CALLS').length, 0);
  });
});

describe('manifests', () => {
  it('reads pyproject in both styles', async () => {
    const pep = await x('pyproject.toml', '[project]\nname = "demo"\ndependencies = ["fastapi>=0.1", "uvicorn"]\n');
    assert.equal(pep.manifest?.name, 'demo');
    assert.deepEqual(pep.manifest?.dependencies.map((d) => d.name), ['fastapi', 'uvicorn']);
    const poetry = await x('pyproject.toml', '[tool.poetry]\nname = "demo"\n[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^5"\n');
    assert.deepEqual(poetry.manifest?.dependencies.map((d) => d.name), ['django']);
  });
  it('marks dev dependencies', async () => {
    const c = await x('Cargo.toml', '[package]\nname = "a"\n[dependencies]\nx = "1"\n[dev-dependencies]\ny = "1"\n');
    assert.deepEqual(c.manifest?.dependencies, [{ name: 'x', dev: false }, { name: 'y', dev: true }]);
    const p = await x('pom.xml', '<project><artifactId>a</artifactId><!-- <dependency><artifactId>ghost</artifactId></dependency> --><dependencies><dependency><groupId>g</groupId><artifactId>t</artifactId><scope>test</scope></dependency></dependencies></project>');
    assert.deepEqual(p.manifest?.dependencies, [{ name: 'g:t', dev: true }]);
    assert.equal(p.manifest?.name, 'a');
  });
  it('flags a broken composer.json', async () => {
    assert.equal((await x('composer.json', '{')).parseErrors, true);
  });
});
