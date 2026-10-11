import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScopes, listScopes } from "../src/scopes.js";
const response = (value) => ({ ok: true, json: async () => value });
test("scope aliases normalize, preserve custom URIs, and include identity scopes once", () => {
  const scopes = resolveScopes([
    "gmail.full",
    "gmail.readonly",
    "gmail.modify",
    "gmail.compose",
    "drive.full",
    "drive.readonly",
    "sheets",
    "sheets.readonly",
    "calendar",
    "calendar.readonly",
    "https://www.googleapis.com/auth/custom.scope",
    "https://www.googleapis.com/auth/userinfo.email",
    "email",
    "openid",
    "gmail.full",
  ]);
  assert.equal(scopes.length, 13);
  assert.equal(scopes.filter((s) => s === "email").length, 1);
  assert.ok(scopes.includes("https://mail.google.com/"));
  assert.deepEqual(resolveScopes([]), ["openid", "email"]);
  for (const value of [
    "https://evil.test/",
    "https://www.googleapis.com/auth/../evil",
    "gmail.nope",
    "https://mail.google.com/evil",
  ])
    assert.throws(
      () => resolveScopes([value]),
      (e) => e.code === "SCOPES_INVALID",
    );
});
test("missing Cloud credential leaves candidates unverified and makes no request", async () => {
  const result = await listScopes({
    projectId: "test-project",
    fetch: () => {
      throw Error("should not request");
    },
  });
  assert.equal(result.enabledStatus, "unverified");
  assert.equal(result.enabledApis.length, 0);
  assert.ok(
    result.candidates.every(
      (c) => c.uri && c.label && c.api && c.enabledStatus === "unverified",
    ),
  );
});
test("Service Usage pages enabled services with fixed filter and trusted origin", async () => {
  const calls = [];
  const result = await listScopes({
    projectId: "test-project",
    cloudTokenEnv: "CLOUD",
    env: { CLOUD: "synthetic-token" },
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(
        calls.length === 1
          ? {
              services: [{ config: { name: "gmail.googleapis.com" } }],
              nextPageToken: "page-two",
            }
          : { services: [{ config: { name: "drive.googleapis.com" } }] },
      );
    },
  });
  assert.equal(result.enabledStatus, "verified");
  assert.deepEqual(result.enabledApis, [
    "gmail.googleapis.com",
    "drive.googleapis.com",
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get("filter"), "state:ENABLED");
  assert.equal(calls[1].url.searchParams.get("pageToken"), "page-two");
  assert.equal(calls[0].url.hostname, "serviceusage.googleapis.com");
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer synthetic-token",
  );
  assert.equal(
    result.candidates.find((c) => c.uri === "https://mail.google.com/")
      .enabledStatus,
    "enabled",
  );
  assert.equal(
    result.candidates.find((c) => c.api === "calendar.googleapis.com")
      .enabledStatus,
    "disabled",
  );
});
test("Cloud protected file and op token sources work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  const file = join(dir, "cloud");
  await writeFile(file, "synthetic-token\n", { mode: 0o600 });
  for (const source of [
    { cloudTokenFile: file },
    {
      cloudTokenOp: {
        vault: "v",
        item: "i",
        field: "cloud",
        tokenEnv: "OP_TEST",
      },
    },
  ]) {
    const result = await listScopes({
      ...source,
      projectId: "test-project",
      env: { OP_TEST: "synthetic" },
      op: async () => ({
        fields: [{ label: "cloud", value: "synthetic-token" }],
      }),
      fetch: async () => response({ services: [] }),
    });
    assert.equal(result.enabledStatus, "verified");
  }
});
test("permission, malformed responses, and repeated pagination are unavailable and safe", async () => {
  for (const fetch of [
    async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "SECRET" }),
    }),
    async () => response({ services: "SECRET" }),
    async () => response({ services: [{ name: "bad" }] }),
    async () => response({ services: [], nextPageToken: "same" }),
    async () => {
      throw Error("SECRET");
    },
  ]) {
    const result = await listScopes({
      projectId: "test-project",
      cloudTokenEnv: "CLOUD",
      env: { CLOUD: "synthetic" },
      fetch,
    });
    assert.equal(result.enabledStatus, "unavailable");
    assert.deepEqual(result.enabledApis, []);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    assert.ok(result.candidates.every((c) => c.enabledStatus === "unverified"));
  }
});
test("Discovery uses fixed origin for selected API and merges its scopes", async () => {
  let requested;
  const result = await listScopes({
    api: "gmail",
    fetch: async (url) => {
      requested = new URL(url);
      return response({
        auth: {
          oauth2: {
            scopes: {
              "https://www.googleapis.com/auth/gmail.metadata": {
                description: "Read message metadata",
              },
            },
          },
        },
      });
    },
  });
  assert.equal(requested.origin, "https://www.googleapis.com");
  assert.equal(requested.pathname, "/discovery/v1/apis/gmail/v1/rest");
  assert.ok(
    result.candidates.some(
      (c) =>
        c.uri.endsWith("/gmail.metadata") &&
        c.label === "Read message metadata",
    ),
  );
  await assert.rejects(
    listScopes({
      api: "https://evil.test",
      fetch: () => {
        throw Error("never");
      },
    }),
    (e) => e.code === "INVALID_CONFIG",
  );
});
test("Discovery request and malformed failures stay sanitized", async () => {
  for (const fetch of [
    async () => ({ ok: false }),
    async () => response({ auth: { oauth2: { scopes: "SECRET" } } }),
    async () => {
      throw Error("SECRET");
    },
  ])
    await assert.rejects(
      listScopes({ api: "gmail", fetch }),
      (e) => e.code === "DISCOVERY_FAILED" && !e.message.includes("SECRET"),
    );
});
test("requests time out even when injected fetch ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const pending = listScopes({
    projectId: "test-project",
    cloudTokenEnv: "CLOUD",
    env: { CLOUD: "synthetic" },
    fetch: async (url, { signal }) => {
      assert.ok(signal);
      started();
      return new Promise(() => {});
    },
  });
  await ready;
  t.mock.timers.tick(10000);
  assert.equal((await pending).enabledStatus, "unavailable");
});
test("Discovery normalizes email aliases without rejecting a valid document", async () => {
  const result = await listScopes({
    api: "people",
    fetch: async () =>
      response({
        auth: {
          oauth2: {
            scopes: {
              "https://www.googleapis.com/auth/userinfo.email": {
                description: "Read your email address",
              },
            },
          },
        },
      }),
  });
  assert.ok(result.candidates.some((c) => c.uri === "email"));
});
test("malformed Service Usage top-level containers remain unavailable", async () => {
  for (const value of [
    [],
    [{}],
    null,
    "synthetic-malformed",
    42,
    { services: {} },
    { services: null },
  ]) {
    const result = await listScopes({
      projectId: "test-project",
      cloudTokenEnv: "CLOUD",
      env: { CLOUD: "synthetic" },
      fetch: async () => response(value),
    });
    assert.equal(result.enabledStatus, "unavailable");
    assert.deepEqual(result.enabledApis, []);
    assert.ok(result.candidates.every((c) => c.enabledStatus === "unverified"));
  }
});
