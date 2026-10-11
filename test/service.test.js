import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshProfile,
  profileStatus,
  profileEnvironment,
} from "../src/service.js";
import { saveProfile } from "../src/config.js";
import { createStore } from "../src/stores.js";
import {
  env,
  profile,
  fakeOAuth,
  clientId,
  clientSecret,
  account,
  scopes,
  customScope,
} from "../fixtures/oauth.js";
async function setup(t, change = {}) {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = profile(dir),
    configDir = join(dir, "profiles");
  await saveProfile(p, { configDir });
  const record = {
    version: 1,
    account,
    client: { clientId, clientSecret },
    requestedScopes: scopes,
    grantedScopes: scopes,
    tokens: {
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      expiry_date: Date.now() + 3600000,
    },
    obtainedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    ...change,
  };
  await createStore(p.store).write(record);
  return { p, record, configDir, dir, options: { env, configDir } };
}
test("status reports metadata without remote refresh or secret fields", async (t) => {
  const { p, options } = await setup(t);
  const status = await profileStatus(p.name, options);
  assert.equal(status.status, "saved");
  assert.equal(status.account, account);
  assert.deepEqual(status.grantedScopes, scopes);
  assert(!JSON.stringify(status).includes("synthetic-access-token"));
  assert(!JSON.stringify(status).includes("synthetic-client-secret"));
  assert(!Object.hasOwn(status, "tokens"));
});
test("refresh verifies account/audience/scopes then saves new access preserving refresh token", async (t) => {
  const { p, options } = await setup(t);
  const fake = fakeOAuth();
  const status = await refreshProfile(p.name, {
    ...options,
    oauthFactory: fake.factory,
  });
  assert.equal(status.status, "saved");
  assert.deepEqual(
    fake.calls.map((c) => c[0]),
    ["refresh", "info"],
  );
  const record = await createStore(p.store).read();
  assert.equal(record.tokens.access_token, "synthetic-refreshed-token");
  assert.equal(record.tokens.refresh_token, "synthetic-refresh-token");
  assert.deepEqual(record.grantedScopes, scopes);
});
for (const [label, change] of [
  ["account", { account: "other@example.com" }],
  ["client", { client: { clientId: "wrong-client", clientSecret } }],
  [
    "scope",
    {
      requestedScopes: ["openid", "email"],
      grantedScopes: ["openid", "email"],
    },
  ],
  ["missing granted identity", { grantedScopes: [customScope, "email"] }],
])
  test(`rejects profile/record ${label} mismatch before refreshing`, async (t) => {
    const { p, options } = await setup(t, change);
    const fake = fakeOAuth();
    await assert.rejects(
      refreshProfile(p.name, { ...options, oauthFactory: fake.factory }),
      { code: "STORE_CONFLICT" },
    );
    await assert.rejects(profileStatus(p.name, options), {
      code: "STORE_CONFLICT",
    });
    assert.equal(fake.calls.length, 0);
  });
test("changed source client is rejected before refreshing", async (t) => {
  const { p, options } = await setup(t);
  const fake = fakeOAuth();
  const changedEnv = {
    TEST_CLIENT: JSON.stringify({
      installed: {
        client_id: "wrong-client",
        client_secret: "synthetic-new-secret",
      },
    }),
  };
  await assert.rejects(
    refreshProfile(p.name, {
      ...options,
      env: changedEnv,
      oauthFactory: fake.factory,
    }),
    { code: "STORE_CONFLICT" },
  );
  assert.equal(fake.calls.length, 0);
});
for (const [label, info, code] of [
  ["audience", { aud: "wrong-client" }, "TOKEN_INVALID"],
  ["account", { email: "other@example.com" }, "ACCOUNT_MISMATCH"],
  ["missing scopes", { scopes: ["openid", "email"] }, "SCOPES_MISSING"],
  ["missing identity", { scopes: [customScope, "openid"] }, "SCOPES_MISSING"],
  ["expired token", { expiry_date: 1 }, "TOKEN_INVALID"],
  ["extra scopes", { scopes: [...scopes, "profile"] }, "STORE_CONFLICT"],
])
  test(`refresh rejects ${label} and preserves existing record`, async (t) => {
    const { p, options, record } = await setup(t);
    const fake = fakeOAuth({ refreshedInfo: info });
    await assert.rejects(
      refreshProfile(p.name, { ...options, oauthFactory: fake.factory }),
      { code },
    );
    assert.deepEqual(await createStore(p.store).read(), record);
  });
test("expired access token is reported and refused for exec but can refresh", async (t) => {
  const { p, options } = await setup(t, {
    tokens: {
      access_token: "synthetic-expired-token",
      refresh_token: "synthetic-refresh-token",
      expiry_date: 1,
    },
  });
  assert.equal((await profileStatus(p.name, options)).status, "expired");
  await assert.rejects(profileEnvironment(p.name, options), {
    code: "TOKEN_EXPIRED",
  });
  assert.equal(
    (
      await refreshProfile(p.name, {
        ...options,
        oauthFactory: fakeOAuth().factory,
      })
    ).status,
    "saved",
  );
});
test("exec environment contains clearly named client/token variables only", async (t) => {
  const { p, options } = await setup(t);
  const result = await profileEnvironment(p.name, options);
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "GRANTLOOM_ACCESS_TOKEN",
      "GRANTLOOM_ACCESS_TOKEN_EXPIRES_AT",
      "GRANTLOOM_CLIENT_ID",
      "GRANTLOOM_CLIENT_SECRET",
      "GRANTLOOM_REFRESH_TOKEN",
    ].sort(),
  );
  assert.equal(result.GRANTLOOM_REFRESH_TOKEN, "synthetic-refresh-token");
  assert.equal(result.GRANTLOOM_CLIENT_ID, clientId);
});
test("missing profile/record and malformed credentials fail safely", async (t) => {
  const { p, options } = await setup(t);
  await assert.rejects(profileStatus("unknown", options), {
    code: "STORE_NOT_FOUND",
  });
  await rm(p.store.path);
  await assert.rejects(profileStatus(p.name, options), {
    code: "STORE_NOT_FOUND",
  });
});
test("raw SDK refresh errors become fixed safe errors", async (t) => {
  const { p, options } = await setup(t);
  const fake = fakeOAuth();
  const factory = (c) => {
    const oauth = fake.factory(c);
    oauth.refreshAccessToken = async () => {
      throw new Error("synthetic-refresh-token synthetic-client-secret");
    };
    return oauth;
  };
  await assert.rejects(
    refreshProfile(p.name, { ...options, oauthFactory: factory }),
    (error) =>
      error.code === "OAUTH_FAILED" && !error.message.includes("synthetic"),
  );
});
test("invalid stored expiry is rejected with a fixed safe error", async (t) => {
  const { p, options } = await setup(t, {
    tokens: {
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      expiry_date: 1e30,
    },
  });
  await assert.rejects(profileStatus(p.name, options), {
    code: "INVALID_RECORD",
  });
  await assert.rejects(profileEnvironment(p.name, options), {
    code: "INVALID_RECORD",
  });
});

for (const failure of ["write", "final read", "final readback mismatch"])
  test(`refresh refuses saved success after 1Password ${failure} failure`, async (t) => {
    const { p, record, options } = await setup(t);
    p.store = { kind: "1password", vault: "synthetic-vault", item: "synthetic-item" };
    await saveProfile(p, options);
    let item, refreshing = false, edited = false, readsAfterEdit = 0;
    const op = async (args, transport) => {
      if (args[1] === "list") return [];
      if (args[1] === "create")
        return item = { ...transport.input, id: "synthetic-item" };
      if (args[1] === "get") {
        if (edited && ++readsAfterEdit === 2) {
          if (failure === "final read")
            throw new Error("synthetic-client-secret synthetic-refresh-token");
          if (failure === "final readback mismatch")
            return {
              ...item,
              fields: item.fields.map((f) => f.label === "access_token"
                ? { ...f, value: "synthetic-stale-token" } : f),
            };
        }
        return item;
      }
      if (args[1] === "edit") {
        if (refreshing && failure === "write")
          throw new Error("synthetic-client-secret synthetic-refresh-token");
        item = { ...transport.input, id: "synthetic-item" };
        edited = refreshing;
        return item;
      }
      throw new Error("Unexpected synthetic op operation");
    };
    // Build the synthetic item through the real store field encoder, without contacting op.
    const initialStore = createStore(
      { kind: "1password", vault: "synthetic-vault", title: "synthetic" },
      { op },
    );
    await initialStore.write(record);
    refreshing = true;
    const fake = fakeOAuth();
    const expectedCode = failure === "final readback mismatch"
      ? "STORE_MISMATCH" : "OP_FAILED";
    await assert.rejects(
      refreshProfile(p.name, { ...options, op, oauthFactory: fake.factory }),
      (error) => error.code === expectedCode && !error.message.includes("synthetic"),
    );
    assert.deepEqual(fake.calls.map((c) => c[0]), ["refresh", "info"]);
    if (failure !== "write") assert.equal(readsAfterEdit, 2);
    else
      assert.equal(
        item.fields.find((f) => f.label === "access_token").value,
        record.tokens.access_token,
      );
  });
