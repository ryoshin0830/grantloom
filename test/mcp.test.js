import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { createStore } from "../src/stores.js";
import { env, profile, fakeOAuth, callback } from "../fixtures/oauth.js";
const names = [
  "auth_start",
  "auth_status",
  "auth_save_retry",
  "auth_cancel",
  "scopes_list",
  "refresh",
  "profile_status",
];
const markers = [
  "synthetic-access-token",
  "synthetic-refresh-token",
  "synthetic-client-secret",
  "synthetic-code",
];
function clean(v) {
  for (const marker of markers) assert(!JSON.stringify(v).includes(marker));
}
const value = (r) => JSON.parse(r.content[0].text);
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeOAuth(options.remote);
  const adapter = createMcpServer({
    authOptions: {
      env,
      configDir: join(dir, "profiles"),
      oauthFactory: fake.factory,
      ...options.authOptions,
    },
    serviceOptions: {
      env,
      configDir: join(dir, "profiles"),
      oauthFactory: fake.factory,
    },
    ...options.adapter,
  });
  const client = new Client({ name: "synthetic-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await adapter.server.connect(st);
  await client.connect(ct);
  t.after(async () => {
    await client.close();
    await adapter.done;
  });
  return {
    dir,
    p: profile(dir),
    fake,
    adapter,
    client,
    call: async (name, args = {}) =>
      await client.callTool({ name, arguments: args }),
  };
}
test("real SDK tools list is exact and every descriptor object schema rejects additional keys", async (t) => {
  const { client } = await setup(t);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), names.sort());
  function strict(schema) {
    if (schema.type === "object")
      assert.equal(schema.additionalProperties, false);
    for (const key of ["properties", "$defs"])
      for (const child of Object.values(schema[key] ?? {})) strict(child);
    for (const key of ["anyOf", "oneOf", "allOf"])
      for (const child of schema[key] ?? []) strict(child);
  }
  for (const tool of tools) strict(tool.inputSchema);
  assert(!JSON.stringify(tools).includes('"clientSecret"'));
  assert(!JSON.stringify(tools).includes('"access_token"'));
});
test("malicious unknown keys and invalid literals return fixed safe tool errors", async (t) => {
  const { call, p } = await setup(t);
  for (const args of [
    { profile: { ...p, "synthetic-client-secret": "synthetic-refresh-token" } },
    {
      profile: {
        ...p,
        clientSource: { env: "TEST_CLIENT", token: "synthetic-access-token" },
      },
    },
    { profile: { ...p, store: { ...p.store, secret: "synthetic-code" } } },
    { profile: { ...p, clientSource: { env: "synthetic-client-secret" } } },
  ]) {
    const r = await call("auth_start", args);
    assert.equal(r.isError, true);
    assert.equal(value(r).code, "INVALID_CONFIG");
    clean(r);
  }
});
test("missing and unknown profiles fail metadata-only, scopes are unverified catalog", async (t) => {
  const { call } = await setup(t);
  for (const [name, args] of [
    ["profile_status", {}],
    ["profile_status", { profile: "missing" }],
    ["refresh", { profile: "missing" }],
    ["unknown", {}],
  ]) {
    const r = await call(name, args);
    assert.equal(r.isError, true);
    clean(r);
  }
  const r = await call("scopes_list");
  assert.equal(value(r).enabledStatus, "unverified");
  assert(value(r).candidates.length > 0);
  clean(r);
});
test("auth start/status/cancel returns only safe metadata and closes real callback", async (t) => {
  const { call, p } = await setup(t);
  const r = value(await call("auth_start", { profile: p }));
  assert.equal(r.status, "pending");
  assert(r.id && r.url);
  clean(r);
  const status = value(await call("auth_status", { id: r.id }));
  assert.equal(status.status, "pending");
  assert(!("url" in status));
  const cancelled = value(await call("auth_cancel", { id: r.id }));
  assert.equal(cancelled.status, "cancelled");
  const redirect = new URL(r.url).searchParams.get("redirect_uri");
  await assert.rejects(fetch(redirect));
  clean(cancelled);
});
test("concurrent starts reserve one session before source/preflight awaits", async (t) => {
  const { call, p } = await setup(t);
  const results = await Promise.all([
    call("auth_start", { profile: p }),
    call("auth_start", { profile: p }),
  ]);
  assert.equal(results.filter((r) => r.isError).length, 1);
  assert.equal(value(results.find((r) => r.isError)).code, "INVALID_CONFIG");
});
test("save-failed remains active; retry stores without another exchange and preserves session ID", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore({ kind: "json", path: join(dir, "saved.json") });
  let writes = 0;
  const failing = {
    ...store,
    write: async (r) => {
      if (++writes === 1) throw new Error("synthetic-refresh-token");
      return store.write(r);
    },
  };
  const { call, p, fake } = await setup(t, { authOptions: { store: failing } });
  const started = value(await call("auth_start", { profile: p }));
  const consent = new URL(started.url);
  const cb = new URL(consent.searchParams.get("redirect_uri"));
  cb.searchParams.set("state", consent.searchParams.get("state"));
  cb.searchParams.set("code", "synthetic-code");
  await fetch(cb);
  assert.equal(
    value(await call("auth_status", { id: started.id })).status,
    "save-failed",
  );
  assert.equal((await call("auth_start", { profile: p })).isError, true);
  const saved = value(await call("auth_save_retry", { id: started.id }));
  assert.equal(saved.status, "saved");
  assert.equal(writes, 2);
  assert.equal(fake.calls.filter((c) => c[0] === "exchange").length, 1);
  clean(saved);
});
test("disconnect cancels pending auth before acknowledging cleanup", async (t) => {
  const { call, p, client, adapter } = await setup(t);
  const started = value(await call("auth_start", { profile: p }));
  await client.close();
  await adapter.done;
  await assert.rejects(
    fetch(new URL(started.url).searchParams.get("redirect_uri")),
  );
  await assert.rejects(access(p.store.path));
});
test("disconnect awaits already-started persistence and leaves truthful saved result", async (t) => {
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const began = new Promise((r) => {
    entered = r;
  });
  const dir = await mkdtemp(join(tmpdir(), "grantloom-commit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore({ kind: "json", path: join(dir, "saved.json") });
  const blocking = {
    ...store,
    write: async (r) => {
      entered();
      await gate;
      return store.write(r);
    },
  };
  const { call, p, client, adapter } = await setup(t, {
    authOptions: { store: blocking },
  });
  const started = value(await call("auth_start", { profile: p }));
  const consent = new URL(started.url);
  const cb = new URL(consent.searchParams.get("redirect_uri"));
  cb.searchParams.set("state", consent.searchParams.get("state"));
  cb.searchParams.set("code", "synthetic-code");
  const request = fetch(cb, { redirect: "manual" }).catch(() => null);
  await began;
  await client.close();
  let done = false;
  adapter.done.then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  release();
  await adapter.done;
  await request;
  assert.equal((await store.read()).account, p.account);
});
test("malicious service exceptions become fixed errors", async (t) => {
  const { call } = await setup(t, {
    adapter: {
      services: {
        refreshProfile: async () => {
          throw new Error(markers.join(" "));
        },
      },
    },
  });
  const r = await call("refresh", { profile: "synthetic" });
  assert.equal(r.isError, true);
  assert.equal(value(r).code, "INTERNAL_ERROR");
  clean(r);
});
test("real stdio server uses JSON-RPC exclusively and closes cleanly on EOF", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-stdio-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("bin/grantloom.js"), "mcp"],
    stderr: "pipe",
    env: { ...env, GRANTLOOM_CONFIG_DIR: join(dir, "profiles") },
  });
  let stderr = "";
  transport.stderr.on("data", (b) => {
    stderr += b;
  });
  const client = new Client({ name: "synthetic-stdio", version: "1" });
  t.after(() => transport.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), names.sort());
  const result = await client.callTool({
    name: "profile_status",
    arguments: { profile: "missing" },
  });
  assert.equal(result.isError, true);
  clean(result);
  const started = value(
    await client.callTool({
      name: "auth_start",
      arguments: { profile: profile(dir) },
    }),
  );
  assert.equal(started.status, "pending");
  clean(started);
  const pid = transport.pid;
  await client.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(
    fetch(new URL(started.url).searchParams.get("redirect_uri")),
  );
  assert.equal(stderr, "");
});
