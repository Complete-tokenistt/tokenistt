import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExpenseProvider, ExpenseTransaction, OrgConfig } from "./types";
import { AI_VENDORS, scanExpense, vendorLabel } from "./scanner";
import { findUserByEmail } from "./users";
import { toDashboardEvents } from "./store";
import { tokenStore, type TokenSet } from "./tokenStore";
import { exchangeCode, getAuthUrl, getValidToken } from "./oauth";
import { fetchTransactions } from "./providers";
import { scanOrg } from "./matcher";

function makeTx(overrides: Partial<ExpenseTransaction> = {}): ExpenseTransaction {
  return {
    id: "tx-1",
    date: "2026-10-15T12:00:00.000Z",
    description: "Card purchase",
    amount: 20,
    currency: "USD",
    vendor: "Example Merchant",
    employeeEmail: "alice@acme.test",
    source: "brex",
    raw: { id: "tx-1" },
    ...overrides,
  };
}

describe("scanner keyword detection and output shape", () => {
  it("exposes expected AI_VENDORS and display labels", () => {
    assert.deepEqual(AI_VENDORS, ["openai", "anthropic", "perplexity"]);
    assert.equal(vendorLabel("openai"), "OpenAI");
    assert.equal(vendorLabel("anthropic"), "Anthropic");
    assert.equal(vendorLabel("perplexity"), "Perplexity");
    assert.equal(vendorLabel("unknown"), "Unknown");
  });

  it("detects OpenAI, ChatGPT, Claude, Anthropic, and Perplexity subscriptions across Brex/Ramp/Navan", () => {
    const cases: {
      name: string;
      tx: ExpenseTransaction;
      expectedVendor: "openai" | "anthropic" | "perplexity";
      expectedKeyword: string;
    }[] = [
      {
        name: "OpenAI merchant on Brex",
        tx: makeTx({ id: "b-1", source: "brex", vendor: "OPENAI *SUBSCRIPTION", description: "Monthly API / Plus" }),
        expectedVendor: "openai",
        expectedKeyword: "openai",
      },
      {
        name: "ChatGPT description on Ramp",
        tx: makeTx({ id: "r-1", source: "ramp", vendor: "STRIPE", description: "ChatGPT Plus subscription" }),
        expectedVendor: "openai",
        expectedKeyword: "openai",
      },
      {
        name: "Chat.GPT dotted variant on Navan",
        tx: makeTx({ id: "n-1", source: "navan", vendor: "CHAT.GPT TEAM", description: "Seat renewal" }),
        expectedVendor: "openai",
        expectedKeyword: "openai",
      },
      {
        name: "Anthropic merchant on Brex",
        tx: makeTx({ id: "b-2", source: "brex", vendor: "Anthropic PBC", description: "Developer console" }),
        expectedVendor: "anthropic",
        expectedKeyword: "anthropic",
      },
      {
        name: "Claude subscription in description on Ramp",
        tx: makeTx({ id: "r-2", source: "ramp", vendor: "CLAUDE.AI SUBSCRIPTION", description: "Claude Pro plan" }),
        expectedVendor: "anthropic",
        expectedKeyword: "anthropic",
      },
      {
        name: "Perplexity subscription on Navan",
        tx: makeTx({ id: "n-2", source: "navan", vendor: "Perplexity AI", description: "Perplexity Pro monthly" }),
        expectedVendor: "perplexity",
        expectedKeyword: "perplexity",
      },
    ];

    for (const c of cases) {
      const result = scanExpense(c.tx);
      assert.ok(result, `Expected match for ${c.name}`);
      assert.deepEqual(Object.keys(result).sort(), ["employeeEmail", "keyword", "transaction", "vendor"]);
      assert.equal(result.transaction, c.tx);
      assert.equal(result.vendor, c.expectedVendor);
      assert.equal(result.keyword, c.expectedKeyword);
      assert.equal(result.employeeEmail, "alice@acme.test");
    }
  });

  it("ignores look-alike and non-AI expenses", () => {
    const nonAiFixtures: ExpenseTransaction[] = [
      makeTx({ id: "la-1", vendor: "Open Air Travel", description: "Flight booking SFO-JFK" }),
      makeTx({ id: "la-2", vendor: "Open Air Bistro", description: "Team lunch" }),
      makeTx({ id: "la-3", vendor: "Chat Group Catering", description: "Offsite snacks" }),
      makeTx({ id: "la-4", vendor: "Anthropology Museum", description: "Event ticket" }),
      makeTx({ id: "la-5", vendor: "Perplex Escape Rooms", description: "Team building activity" }),
      makeTx({ id: "la-6", vendor: "Amazon Web Services", description: "Cloud hosting" }),
    ];

    for (const tx of nonAiFixtures) {
      assert.equal(scanExpense(tx), null, `Expected null for ${tx.vendor} (${tx.description})`);
    }
  });

  it("falls back to extracting employee email from description or vendor when missing on transaction", () => {
    const withEmbeddedEmail = makeTx({
      employeeEmail: undefined,
      vendor: "OpenAI",
      description: "ChatGPT Plus seat for dev.user+ai@acme.io",
    });
    const scanned = scanExpense(withEmbeddedEmail);
    assert.ok(scanned);
    assert.equal(scanned.employeeEmail, "dev.user+ai@acme.io");

    const withoutAnyEmail = makeTx({
      employeeEmail: undefined,
      vendor: "Perplexity",
      description: "Corporate card charge",
    });
    const scannedNoEmail = scanExpense(withoutAnyEmail);
    assert.ok(scannedNoEmail);
    assert.equal(scannedNoEmail.employeeEmail, undefined);
  });
});

describe("OAuth, provider adapters, and end-to-end org scan (offline mocked HTTP)", () => {
  const originalFetch = globalThis.fetch;
  const originalGet = tokenStore.get;
  const originalSet = tokenStore.set;
  let memoryTokens: Map<string, TokenSet>;

  beforeEach(() => {
    memoryTokens = new Map<string, TokenSet>();
    tokenStore.get = (provider: ExpenseProvider, orgId: string) => memoryTokens.get(`${provider}:${orgId}`);
    tokenStore.set = (provider: ExpenseProvider, orgId: string, token: TokenSet) => {
      memoryTokens.set(`${provider}:${orgId}`, token);
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected unmocked network call: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    tokenStore.get = originalGet;
    tokenStore.set = originalSet;
  });

  it("builds OAuth URLs, exchanges authorization codes, and refreshes expired tokens without network I/O", async () => {
    const authUrl = new URL(getAuthUrl("brex", "csrf-123"));
    assert.equal(authUrl.origin + authUrl.pathname, "https://api.brex.com/oauth/authorize");
    assert.equal(authUrl.searchParams.get("response_type"), "code");
    assert.equal(authUrl.searchParams.get("scope"), "transactions:read");
    assert.equal(authUrl.searchParams.get("state"), "brex:csrf-123");

    const calls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });

      if (body.grant_type === "authorization_code") {
        return new Response(
          JSON.stringify({ access_token: "brex-access-1", refresh_token: "brex-refresh-1", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.grant_type === "refresh_token") {
        return new Response(
          JSON.stringify({ access_token: "brex-access-2", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;

    assert.equal(await getValidToken("brex", "org-1"), null);

    await exchangeCode("brex", "auth-code-xyz", "org-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.brex.com/oauth/token");
    assert.equal(calls[0].body.code, "auth-code-xyz");
    assert.equal(await getValidToken("brex", "org-1"), "brex-access-1");
    assert.equal(calls.length, 1, "Fresh token should not trigger refresh");

    // Force token expiration to exercise refresh flow
    memoryTokens.set("brex:org-1", {
      accessToken: "stale-token",
      refreshToken: "brex-refresh-1",
      expiresAt: Date.now() - 120_000,
    });
    assert.equal(await getValidToken("brex", "org-1"), "brex-access-2");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.grant_type, "refresh_token");
  });

  it("normalizes paginated Brex and Ramp transactions and skips Navan cleanly", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      assert.equal(auth, "Bearer tok-test");

      if (url === "https://api.brex.com/v1/transactions?limit=100&start_date=2026-10-01") {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                id: "bx-1",
                date: "2026-10-02T00:00:00Z",
                description: "ChatGPT Plus",
                merchant_name: "OPENAI",
                amount: -2000,
                currency: "USD",
                user: { email: "bob@acme.test" },
              },
            ],
            page: { next_url: "https://api.brex.com/v1/transactions?cursor=page2" },
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.brex.com/v1/transactions?cursor=page2") {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                id: "bx-2",
                posted_at: "2026-10-03T00:00:00Z",
                merchant_name: "Open Air Travel",
                amount: 45050,
                employee: { email: "carol@acme.test" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.ramp.com/developer/v1/transactions?limit=100&from_date=2026-10-01") {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                id: "rp-1",
                posted_at: "2026-10-04T00:00:00Z",
                merchant: "Anthropic",
                description: "Claude Team",
                amount: 3000,
                currency: "USD",
                user_email: "dana@acme.test",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const brexTxs = await fetchTransactions("brex", "tok-test", "2026-10-01T00:00:00.000Z");
    assert.equal(brexTxs.length, 2);
    assert.equal(brexTxs[0].amount, 20);
    assert.equal(brexTxs[0].vendor, "OPENAI");
    assert.equal(brexTxs[0].employeeEmail, "bob@acme.test");
    assert.equal(brexTxs[1].amount, 450.5);
    assert.equal(brexTxs[1].vendor, "Open Air Travel");

    const rampTxs = await fetchTransactions("ramp", "tok-test", "2026-10-01T00:00:00.000Z");
    assert.equal(rampTxs.length, 1);
    assert.equal(rampTxs[0].amount, 30);
    assert.equal(rampTxs[0].vendor, "Anthropic");
    assert.equal(rampTxs[0].employeeEmail, "dana@acme.test");

    const navanTxs = await fetchTransactions("navan", "tok-test", "2026-10-01T00:00:00.000Z");
    assert.deepEqual(navanTxs, []);
  });

  it("produces stable ScanResult and DashboardEvent shapes in scanOrg with mocked OAuth + HTTP", async () => {
    memoryTokens.set("brex:acme", { accessToken: "brex-tok" });
    memoryTokens.set("ramp:acme", { accessToken: "ramp-tok" });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.brex.com/v1/transactions")) {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                id: "101",
                date: "2026-10-10T10:00:00Z",
                description: "ChatGPT Plus",
                merchant_name: "OpenAI",
                amount: 2000,
                currency: "USD",
                user: { email: "alice@acme.test" },
              },
              {
                id: "102",
                date: "2026-10-11T10:00:00Z",
                description: "Flight",
                merchant_name: "Open Air Travel",
                amount: 35000,
                currency: "USD",
                user: { email: "alice@acme.test" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://api.ramp.com/developer/v1/transactions")) {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                id: "202",
                posted_at: "2026-10-12T10:00:00Z",
                merchant: "Perplexity",
                description: "Perplexity Pro",
                amount: 2000,
                currency: "USD",
                user: { email: "bob@acme.test" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const org: OrgConfig = {
      orgId: "acme",
      providers: ["brex", "ramp", "navan"],
      users: [{ email: "alice@acme.test", actor: "alice-corp", name: "Alice" }],
    };

    assert.deepEqual(findUserByEmail(org, "ALICE@acme.test"), {
      email: "alice@acme.test",
      actor: "alice-corp",
      name: "Alice",
    });
    assert.deepEqual(findUserByEmail(org, "bob@acme.test"), {
      email: "bob@acme.test",
      actor: "bob",
    });
    assert.equal(findUserByEmail(org, undefined), null);

    const result = await scanOrg(org, "2026-10-01T00:00:00.000Z", "2026-10-31T23:59:59.000Z");

    assert.deepEqual(Object.keys(result).sort(), [
      "findings",
      "orgId",
      "periodEnd",
      "periodStart",
      "runAt",
      "totals",
    ]);
    assert.equal(result.orgId, "acme");
    assert.equal(result.periodStart, "2026-10-01T00:00:00.000Z");
    assert.equal(result.periodEnd, "2026-10-31T23:59:59.000Z");
    assert.equal(result.findings.length, 2, "Look-alike Open Air Travel must be excluded");

    const [first, second] = result.findings;
    assert.deepEqual(Object.keys(first).sort(), [
      "amountUsd",
      "apiSpendUsd",
      "detectedAt",
      "employeeEmail",
      "hasGatewayUsage",
      "id",
      "note",
      "shadow",
      "source",
      "trueCostUsd",
      "vendor",
    ]);
    assert.equal(first.id, "sf-brex-101");
    assert.equal(first.vendor, "OpenAI");
    assert.equal(first.amountUsd, 20);
    assert.equal(first.shadow, true);
    assert.equal(first.hasGatewayUsage, false);
    assert.equal(first.trueCostUsd, 20);
    assert.match(first.note, /alice-corp/);

    assert.equal(second.id, "sf-ramp-202");
    assert.equal(second.vendor, "Perplexity");
    assert.equal(second.amountUsd, 20);
    assert.match(second.note, /bob/);

    assert.deepEqual(result.totals, {
      shadowSpendUsd: 40,
      expensedUsd: 40,
      apiSpendUsd: 0,
      trueCostUsd: 40,
      shadowCount: 2,
    });

    const events = toDashboardEvents(result.findings);
    assert.equal(events.length, 2);
    assert.deepEqual(Object.keys(events[0]).sort(), [
      "actor",
      "amountUsd",
      "detectedAt",
      "id",
      "note",
      "source",
      "status",
      "vendor",
    ]);
    assert.equal(events[0].status, "unreviewed");
    assert.equal(events[0].actor, "alice@acme.test");
  });
});
