import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mask, redactText } from '../src/core/redact.js';
import { Output, csvCell, shouldUseColor } from '../src/core/output.js';
import { ApiError, AuthError, ExitCode, NetworkError, UsageError } from '../src/core/errors.js';

function capture() {
  let out = '';
  let err = '';
  return {
    stdout: { write: (s: string) => { out += s; return true; } },
    stderr: { write: (s: string) => { err += s; return true; } },
    get out() { return out; },
    get err() { return err; },
  };
}

describe('redaction', () => {
  it('masks credentials but keeps enough to tell them apart', () => {
    assert.equal(mask('tktt_live_ws_dev_0123456789abcdef'), 'tktt_live_…cdef');
    assert.equal(mask('short'), '****');
    assert.equal(mask(undefined), '(none)');
  });

  it('scrubs every credential shape from free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.abcdefghijk';
    const text = `key tktt_live_a_b_c0ffee Authorization: Bearer abcdef0123456789 jwt ${jwt} openai sk-abcdefghijklmnopqrstu x-admin-secret: hunter2hunter2`;
    const out = redactText(text);
    for (const secret of ['c0ffee', 'abcdef0123456789', jwt, 'sk-abcdefghijklmnopqrstu', 'hunter2hunter2']) assert.ok(!out.includes(secret), `leaked ${secret}`);
  });
});

describe('output', () => {
  it('neutralises spreadsheet formulas and quotes special characters', () => {
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell(null), '');
  });

  it('renders csv with a header row', () => {
    const o = new Output({});
    assert.equal(o.csv([{ a: 1, b: 'x,y' }], ['a', 'b']), 'a,b\n1,"x,y"\n');
  });

  it('--json prints only the result; info is suppressed', () => {
    const c = capture();
    const o = new Output({ json: true, stdout: c.stdout, stderr: c.stderr });
    o.info('chatter');
    o.success('done');
    o.result({ ok: true }, () => o.line('human'));
    assert.deepEqual(JSON.parse(c.out), { ok: true });
    assert.equal(c.err, '');
  });

  it('--quiet hides info but still prints results', () => {
    const c = capture();
    const o = new Output({ quiet: true, stdout: c.stdout, stderr: c.stderr });
    o.info('chatter');
    o.result({}, () => o.line('result'));
    assert.equal(c.out, 'result\n');
  });

  it('errors go to stderr, redacted, and as JSON in --json mode', () => {
    const c = capture();
    new Output({ json: true, stdout: c.stdout, stderr: c.stderr }).error('bad key tktt_live_x_y_z123', 'try again', 3);
    const e = JSON.parse(c.err);
    assert.equal(e.error.exit_code, 3);
    assert.ok(!c.err.includes('z123'));
    const h = capture();
    new Output({ stdout: h.stdout, stderr: h.stderr }).error('nope', 'do this');
    assert.match(h.err, /nope/);
    assert.match(h.err, /do this/);
  });

  it('debug lines appear only with --verbose and are redacted', () => {
    const quiet = capture();
    new Output({ stdout: quiet.stdout, stderr: quiet.stderr }).debug('x');
    assert.equal(quiet.err, '');
    const loud = capture();
    new Output({ verbose: true, stdout: loud.stdout, stderr: loud.stderr }).debug('Bearer abcdefghijklmnop');
    assert.ok(!loud.err.includes('abcdefghijklmnop'));
  });

  it('aligns tables and handles empty data', () => {
    const c = capture();
    const o = new Output({ stdout: c.stdout, stderr: c.stderr });
    o.table([{ n: 'a', v: 1 }, { n: 'bbb', v: 22 }], [{ key: 'n' }, { key: 'v', align: 'right' }]);
    const lines = c.out.trimEnd().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[2] ?? '', /^a {3}/);
    const e = capture();
    new Output({ stdout: e.stdout, stderr: e.stderr }).table([], [{ key: 'x' as never }]);
    assert.match(e.out, /no data/);
  });

  it('respects NO_COLOR, --no-color and non-TTY', () => {
    assert.equal(shouldUseColor({ NO_COLOR: '1' }, true, false), false);
    assert.equal(shouldUseColor({}, true, true), false);
    assert.equal(shouldUseColor({}, false, false), false);
    assert.equal(shouldUseColor({}, true, false), true);
  });
});

describe('exit codes', () => {
  it('are stable and distinguish auth, network and usage failures', () => {
    assert.equal(new UsageError('x').exitCode, ExitCode.Usage);
    assert.equal(new AuthError('x').exitCode, ExitCode.Auth);
    assert.equal(new NetworkError('x').exitCode, ExitCode.Network);
    assert.equal(new ApiError('x', 401).exitCode, ExitCode.Auth);
    assert.equal(new ApiError('x', 500).exitCode, ExitCode.Error);
  });
});
