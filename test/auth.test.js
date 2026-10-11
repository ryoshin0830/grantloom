import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request, createServer } from "node:http";
import { startAuth } from "../src/auth.js";
import { createStore } from "../src/stores.js";
import { profileStatus, refreshProfile, profileEnvironment } from "../src/service.js";
import { loadProfile } from "../src/config.js";
import {
  env,
  profile,
  fakeOAuth,
  callback,
  clientId,
  customScope,
  scopes,
} from "../fixtures/oauth.js";
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeOAuth(options.remote);
  const p = profile(dir);
  const session = await startAuth(
    { ...p, ...options.profile },
    {
      env,
      configDir: join(dir, "profiles"),
      oauthFactory: fake.factory,
      ...options.start,
    },
  );
  t.after(() => session.cancel());
  return { dir, p, session, fake };
}
function rawGet(url, host) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}
test("real callback verifies PKCE, identity, both access tokens then privately saves", async (t) => {
  const { session, fake, p, dir } = await setup(t);
  const url = new URL(session.url);
  for (const [k, v] of Object.entries({
    access_type: "offline",
    prompt: "consent",
    code_challenge_method: "S256",
    login_hint: p.account,
    client_id: clientId,
    redirect_uri: session.redirectUri,
  }))
    assert.equal(url.searchParams.get(k), v);
  assert.deepEqual(url.searchParams.get("scope").split(" "), scopes);
  assert(url.searchParams.get("nonce"));
  assert(url.searchParams.get("state"));
  assert.equal(new URL(session.redirectUri).hostname, "127.0.0.1");
  assert.equal((await fetch(callback(session))).status, 200);
  assert.equal((await session.done).status, "saved");
  assert.deepEqual(
    fake.calls.map((c) => c[0]),
    ["exchange", "verify", "info", "refresh", "info"],
  );
  const exchange = fake.calls[0][1];
  assert.equal(
    createHash("sha256").update(exchange.codeVerifier).digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  assert.equal(exchange.redirect_uri, session.redirectUri);
  assert.equal(fake.calls[1][1].audience, clientId);
  const record = await createStore(p.store).read();
  assert.equal(record.tokens.access_token, "synthetic-refreshed-token");
  assert.equal(record.tokens.refresh_token, "synthetic-refresh-token");
  assert.deepEqual(record.requestedScopes, scopes);
  assert.deepEqual(record.grantedScopes, scopes);
  assert.equal((await stat(p.store.path)).mode & 0o777, 0o600);
  assert.equal(
    (await loadProfile(p.name, { configDir: join(dir, "profiles") })).name,
    p.name,
  );
  assert(!JSON.stringify(session.status()).includes("synthetic-access-token"));
  assert(!JSON.stringify(session).includes("synthetic-client-secret"));
});
test("bogus path, host, state and duplicate query never consume the callback", async (t) => {
  const { session, fake } = await setup(t);
  assert.equal(await rawGet(callback(session), "evil.example"), 400);
  const badPath = callback(session);
  badPath.pathname = "/wrong";
  assert.equal((await fetch(badPath)).status, 400);
  assert.equal(
    (await fetch(callback(session, { state: "wrong" }))).status,
    400,
  );
  for (const key of ["state", "code", "error"]) {
    const duplicate = callback(session);
    duplicate.searchParams.append(key, "x");
    duplicate.searchParams.append(key, "y");
    assert.equal((await fetch(duplicate)).status, 400);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal((await fetch(callback(session))).status, 200);
  assert.equal((await session.done).status, "saved");
  await assert.rejects(fetch(callback(session)));
});
for (const [label, remote, code] of [
  [
    "wrong email",
    { payload: { email: "other@example.com" } },
    "ACCOUNT_MISMATCH",
  ],
  ["unknown email", { payload: { email: undefined } }, "ACCOUNT_MISMATCH"],
  [
    "unverified email",
    { payload: { email_verified: false } },
    "ACCOUNT_MISMATCH",
  ],
  ["nonce mismatch", { payload: { nonce: "wrong" } }, "TOKEN_INVALID"],
  ["audience mismatch", { payload: { aud: "other-client" } }, "TOKEN_INVALID"],
  [
    "missing refresh token",
    { tokens: { refresh_token: undefined } },
    "REFRESH_MISSING",
  ],
  [
    "access audience mismatch",
    { info: { aud: "other-client" } },
    "TOKEN_INVALID",
  ],
  [
    "access wrong account",
    { info: { email: "other@example.com" } },
    "ACCOUNT_MISMATCH",
  ],
  [
    "scope deficit",
    { info: { scopes: ["openid", "email"] } },
    "SCOPES_MISSING",
  ],
  [
    "missing identity scope",
    { info: { scopes: [customScope, "email"] } },
    "SCOPES_MISSING",
  ],
  [
    "refresh account mismatch",
    { refreshedInfo: { email: "other@example.com" } },
    "ACCOUNT_MISMATCH",
  ],
  [
    "refresh scope change",
    { refreshedInfo: { scopes: ["openid", "email"] } },
    "SCOPES_MISSING",
  ],
  ["SDK failure", { error: true }, "OAUTH_FAILED"],
])
  test(`rejects ${label} without saving or leaking`, async (t) => {
    const { session, p } = await setup(t, { remote });
    const response = await fetch(callback(session));
    const body = await response.text();
    const status = await session.done;
    assert.equal(status.status, "failed");
    assert.equal(status.code, code);
    assert(!body.includes("synthetic"));
    assert(!JSON.stringify(status).includes("synthetic-access-token"));
    await assert.rejects(createStore(p.store).read(), {
      code: "STORE_NOT_FOUND",
    });
  });
test("OAuth denial is fixed safe failure", async (t) => {
  const { session, fake } = await setup(t);
  const response = await fetch(
    callback(session, {
      code: null,
      error: "access_denied",
      error_description: "synthetic-client-secret",
    }),
  );
  assert(!(await response.text()).includes("synthetic"));
  assert.equal((await session.done).code, "OAUTH_DENIED");
  assert.equal(fake.calls.length, 0);
});
test("save failure retains verified record and retries without another exchange", async (t) => {
  let fail = true,
    record;
  const store = {
    preflight: async () => {},
    reference: { kind: "json", path: "/synthetic" },
    write: async (r) => {
      if (fail) throw new Error("synthetic-client-secret");
      record = structuredClone(r);
      return store.reference;
    },
    read: async () => structuredClone(record),
  };
  const { session, fake } = await setup(t, { start: { store } });
  await fetch(callback(session));
  assert.equal((await session.done).status, "save-failed");
  fail = false;
  assert.equal((await session.retrySave()).status, "saved");
  assert.equal(fake.calls.length, 5);
});
test("readback mismatch never reports saved", async (t) => {
  const store = {
    preflight: async () => {},
    reference: { kind: "json", path: "/synthetic" },
    write: async () => store.reference,
    read: async () => ({}),
  };
  const { session } = await setup(t, { start: { store } });
  await fetch(callback(session));
  assert.equal((await session.done).code, "STORE_MISMATCH");
});
test("profile write failure after token save is retryable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-profile-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "blocked"), { mode: 0o700 });
  const { session, fake } = await setup(t, {
    start: { configDir: join(dir, "blocked") },
  });
  const { chmod } = await import("node:fs/promises");
  await chmod(join(dir, "blocked"), 0o777);
  await fetch(callback(session));
  assert.equal((await session.done).status, "save-failed");
  await chmod(join(dir, "blocked"), 0o700);
  assert.equal((await session.retrySave()).status, "saved");
  assert.equal(fake.calls.length, 5);
});
for (const mode of ["cancel", "timeout"])
  test(`${mode} clears an in-flight exchange and releases listener`, async (t) => {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const { session, fake, p } = await setup(t, {
      remote: { wait },
      start: { timeoutMs: mode === "timeout" ? 30 : 1000 },
    });
    const request = fetch(callback(session)).catch(() => null);
    while (!fake.calls.length) await new Promise((r) => setTimeout(r, 1));
    if (mode === "cancel") await session.cancel();
    assert.equal(
      (await session.done).status,
      mode === "cancel" ? "cancelled" : "expired",
    );
    release();
    await request;
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(createStore(p.store).read(), {
      code: "STORE_NOT_FOUND",
    });
    await assert.rejects(fetch(callback(session)));
  });
test("idle cancellation and timeout release ephemeral ports", async (t) => {
  const { session } = await setup(t, { start: { timeoutMs: 15 } });
  assert.equal((await session.done).status, "expired");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(new URL(session.redirectUri).port),
      "127.0.0.1",
      resolve,
    );
  });
  await new Promise((r) => server.close(r));
});
test("web callback uses exact registered port/path and rejects unregistered URI", async (t) => {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const redirectUri = `http://127.0.0.1:${port}/registered`;
  const webEnv = {
    TEST_CLIENT: JSON.stringify({
      web: {
        client_id: clientId,
        client_secret: "synthetic-client-secret",
        redirect_uris: [redirectUri],
      },
    }),
  };
  const { session } = await setup(t, {
    profile: { redirectUri },
    start: { env: webEnv },
  });
  assert.equal(session.redirectUri, redirectUri);
  await session.cancel();
  const dir = await mkdtemp(join(tmpdir(), "grantloom-web-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    startAuth(
      { ...profile(dir), redirectUri: redirectUri + "/other" },
      { env: webEnv },
    ),
    { code: "INVALID_CONFIG" },
  );
});
for (const [label, remote] of [
  ["unverified", { info: { email_verified: false } }],
  ["unknown verification", { info: { email_verified: undefined } }],
])
  test(`rejects access token with ${label} email`, async (t) => {
    const { session } = await setup(t, { remote });
    await fetch(callback(session));
    assert.equal((await session.done).code, "ACCOUNT_MISMATCH");
  });
for (const [label, remote, params] of [
  ["saved", {}, {}],
  ["failed", { payload: { nonce: "wrong" } }, {}],
  ["denied", {}, { code: null, error: "access_denied" }],
])
  test(`${label} callback redirects to a clean nonsecret completion URL`, async (t) => {
    const { session } = await setup(t, { remote });
    const response = await fetch(callback(session, params), {
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    const destination = new URL(
      response.headers.get("location"),
      session.redirectUri,
    );
    assert.equal(destination.origin, new URL(session.redirectUri).origin);
    assert.equal(destination.pathname, "/complete");
    assert.equal(destination.search, "");
    const completed = await fetch(destination);
    assert.equal(completed.status, 200);
    assert(!(await completed.text()).includes("synthetic"));
    await session.done;
    await assert.rejects(fetch(destination));
  });
for (const failure of [false, true])
  test(`cancellation during persistence waits for ${failure ? "failed" : "successful"} commit`, async (t) => {
    let release, started;
    const wait = new Promise((r) => {
        release = r;
      }),
      ready = new Promise((r) => {
        started = r;
      });
    let record,
      writes = 0;
    const store = {
      reference: { kind: "json", path: "/synthetic" },
      preflight: async () => {},
      write: async (r) => {
        writes++;
        started();
        await wait;
        if (failure) throw new Error("synthetic");
        record = structuredClone(r);
        return store.reference;
      },
      read: async () => record,
    };
    const { session } = await setup(t, { start: { store } });
    const request = fetch(callback(session)).catch(() => null);
    await ready;
    let acknowledged = false;
    const cancelling = session.cancel().then((status) => {
      acknowledged = true;
      return status;
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(acknowledged, false);
    assert.equal(session.status().status, "saving");
    release();
    assert.equal((await cancelling).status, failure ? "cancelled" : "saved");
    assert.equal((await session.done).status, failure ? "cancelled" : "saved");
    assert.equal(writes, 1);
    await request;
  });
test("expiry during persistence waits for the already-started commit", async (t) => {
  let release, started;
  const wait = new Promise((r) => {
      release = r;
    }),
    ready = new Promise((r) => {
      started = r;
    });
  let record;
  const store = {
    reference: { kind: "json", path: "/synthetic" },
    preflight: async () => {},
    write: async (r) => {
      started();
      await wait;
      record = structuredClone(r);
      return store.reference;
    },
    read: async () => record,
  };
  const { session } = await setup(t, { start: { store, timeoutMs: 25 } });
  const request = fetch(callback(session)).catch(() => null);
  await ready;
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(session.status().status, "saving");
  release();
  assert.equal((await session.done).status, "saved");
  await request;
});
test("official SDK verifies a signed synthetic ID token with fake remote transport only", async (t) => {
  const { OAuth2Client } = await import("google-auth-library");
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  let session,
    refresh = false;
  const methods = [];
  const factory = (options) => {
    const oauth = new OAuth2Client(options);
    oauth.transporter.request = async (request) => {
      const url = String(request.url);
      methods.push(url);
      if (url.includes("/certs"))
        return {
          data: {
            synthetic: publicKey.export({ type: "spki", format: "pem" }),
          },
          headers: new Headers({ "cache-control": "max-age=3600" }),
        };
      if (url.includes("tokeninfo"))
        return {
          data: {
            aud: clientId,
            email: "student@example.com",
            email_verified: true,
            scope: scopes.join(" "),
            expires_in: 3600,
          },
        };
      assert.equal(url, "https://oauth2.googleapis.com/token");
      if (request.data.get("grant_type") === "refresh_token") {
        refresh = true;
        return {
          data: { access_token: "synthetic-refreshed-token", expires_in: 3600 },
        };
      }
      const encode = (o) =>
        Buffer.from(JSON.stringify(o)).toString("base64url");
      const epoch = Math.floor(Date.now() / 1000);
      const unsigned =
        encode({ alg: "RS256", kid: "synthetic" }) +
        "." +
        encode({
          iss: "https://accounts.google.com",
          aud: clientId,
          iat: epoch,
          exp: epoch + 3600,
          nonce: new URL(session.url).searchParams.get("nonce"),
          email: "student@example.com",
          email_verified: true,
        });
      const jwt =
        unsigned +
        "." +
        sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString(
          "base64url",
        );
      return {
        data: {
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          id_token: jwt,
          expires_in: 3600,
        },
      };
    };
    return oauth;
  };
  const setupResult = await setup(t, { start: { oauthFactory: factory } });
  session = setupResult.session;
  assert.equal((await fetch(callback(session))).status, 200);
  assert.equal((await session.done).status, "saved");
  assert(refresh);
  assert.equal(methods.length, 5);
});
test("factory startup failure releases registered listener and sanitizes error", async (t) => {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const webEnv = {
    TEST_CLIENT: JSON.stringify({
      web: {
        client_id: clientId,
        client_secret: "synthetic-client-secret",
        redirect_uris: [redirectUri],
      },
    }),
  };
  const dir = await mkdtemp(join(tmpdir(), "grantloom-start-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    startAuth(
      { ...profile(dir), redirectUri },
      {
        env: webEnv,
        oauthFactory: () => {
          throw new Error("synthetic-client-secret");
        },
      },
    ),
    (error) =>
      error.code === "OAUTH_FAILED" && !error.message.includes("synthetic"),
  );
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((r) => server.close(r));
});
test("registered busy port fails safely instead of selecting another port", async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const webEnv = {
    TEST_CLIENT: JSON.stringify({
      web: {
        client_id: clientId,
        client_secret: "synthetic-client-secret",
        redirect_uris: [redirectUri],
      },
    }),
  };
  const dir = await mkdtemp(join(tmpdir(), "grantloom-busy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    startAuth({ ...profile(dir), redirectUri }, { env: webEnv }),
    { code: "OAUTH_FAILED" },
  );
});
test("expiry after save-failed destroys retained credentials and disables retry", async (t) => {
  const store = {
    reference: { kind: "json", path: "/synthetic" },
    preflight: async () => {},
    write: async () => {
      throw new Error("synthetic");
    },
  };
  const { session } = await setup(t, { start: { store, timeoutMs: 25 } });
  await fetch(callback(session));
  assert.equal((await session.done).status, "save-failed");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(session.status().status, "expired");
  assert.equal(session.status().expiresAt, null);
  await assert.rejects(session.retrySave(), { code: "AUTH_EXPIRED" });
});
test("clock expiry during save retry clears pending state immediately", async (t) => {
  let clock = Date.now();
  const store = {
    reference: { kind: "json", path: "/synthetic" },
    preflight: async () => {},
    write: async () => {
      throw new Error("synthetic");
    },
  };
  const { session } = await setup(t, {
    start: { store, now: () => clock, timeoutMs: 1000 },
  });
  await fetch(callback(session));
  assert.equal((await session.done).status, "save-failed");
  clock += 1001;
  await assert.rejects(session.retrySave(), { code: "AUTH_EXPIRED" });
  assert.equal(session.status().status, "expired");
  assert.equal(session.status().expiresAt, null);
});
test("invalid token-info expiry cannot be persisted", async (t) => {
  const { session, p } = await setup(t, {
    remote: { info: { expiry_date: 1e30 } },
  });
  await fetch(callback(session));
  assert.equal((await session.done).code, "TOKEN_INVALID");
  await assert.rejects(createStore(p.store).read(), {
    code: "STORE_NOT_FOUND",
  });
});
test("1Password final item reference is saved in profile with transport descriptors retained", async (t) => {
  let item;
  const transportCalls = [];
  const op = async (args, options) => {
    transportCalls.push({ args, tokenEnv: options.tokenEnv });
    if (args[0] === "vault") return { id: "synthetic-vault" };
    if (args[1] === "list")
      return item ? [{ id: item.id, title: item.title }] : [];
    if (args[1] === "create") {
      item = { ...options.input, id: "synthetic-stable-id" };
      return item;
    }
    if (args[1] === "get") return item;
    throw new Error("Unexpected synthetic op operation");
  };
  const store = {
    kind: "1password",
    vault: "synthetic-vault",
    title: "synthetic-credentials",
    tokenEnv: "TEST_OP_TOKEN",
    refreshField: "synthetic_refresh",
  };
  const { session, dir, p } = await setup(t, {
    profile: { store },
    start: { op, env: { ...env, TEST_OP_TOKEN: "synthetic-service-token" } },
  });
  await fetch(callback(session));
  assert.equal((await session.done).status, "saved");
  const saved = await loadProfile(p.name, { configDir: join(dir, "profiles") });
  assert.deepEqual(saved.store, {
    kind: "1password",
    vault: "synthetic-vault",
    item: "synthetic-stable-id",
    tokenEnv: "TEST_OP_TOKEN",
    refreshField: "synthetic_refresh",
  });
  assert(transportCalls.every((call) => call.tokenEnv === "TEST_OP_TOKEN"));
  assert.equal(session.status().storage.item, "synthetic-stable-id");
  assert(!JSON.stringify(session.status()).includes("synthetic-service-token"));
});
test("done-driven adapter cleanup does not prevent the clean callback redirect", async (t) => {
  const { session } = await setup(t);
  const cleanup = session.done.then(() => session.cancel());
  const response = await fetch(callback(session), { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/complete");
  await cleanup;
});
test("retry on an already-saved session cannot expire its successful status", async (t) => {
  let clock = Date.now();
  const { session } = await setup(t, {
    start: { now: () => clock, timeoutMs: 1000 },
  });
  await fetch(callback(session));
  assert.equal((await session.done).status, "saved");
  clock += 1001;
  await assert.rejects(session.retrySave(), { code: "INVALID_CONFIG" });
  assert.equal(session.status().status, "saved");
});

for (const kind of ["client", "json", "env", "existing unrelated"])
  test(`auth rejects profile destination collision before consent: ${kind}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "grantloom-auth-collision-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const p = profile(dir), configDir = join(dir, "profiles");
    await mkdir(configDir, { mode: 0o700 });
    const destination = join(configDir, p.name + ".json");
    const original = kind === "client" ? env.TEST_CLIENT : "synthetic unrelated private bytes";
    if (kind === "client") p.clientSource = { file: destination };
    else if (kind !== "existing unrelated")
      p.store = {
        kind,
        path: join(configDir, "..", "profiles", p.name + ".json"),
      };
    if (kind === "client" || kind === "existing unrelated")
      await writeFile(destination, original, { mode: 0o600 });
    const fake = fakeOAuth();
    await assert.rejects(async () => {
      const session = await startAuth(p, { env, configDir, oauthFactory: fake.factory });
      await session.cancel();
    }, { code: "INVALID_CONFIG" });
    assert.equal(fake.oauth, undefined);
    if (kind === "client" || kind === "existing unrelated")
      assert.equal(await readFile(destination, "utf8"), original);
    else await assert.rejects(readFile(destination), { code: "ENOENT" });
  });
test("relative auth references survive cwd change before save and subsequent profile operations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-auth-paths-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const originalCwd = process.cwd();
  const otherDir = join(dir, "other");
  await mkdir(otherDir, { mode: 0o700 });
  let session;
  try {
    process.chdir(dir);
    await writeFile("client.json", env.TEST_CLIENT, { mode: 0o600 });
    const base = process.cwd();
    const p = {
      ...profile(dir),
      clientSource: { file: "client.json" },
      store: { kind: "json", path: "tokens.json" },
    };
    session = await startAuth(p, { configDir: "profiles", oauthFactory: fakeOAuth().factory });
    process.chdir(otherDir);
    assert.equal((await fetch(callback(session))).status, 200);
    assert.equal((await session.done).status, "saved");
    const options = { configDir: join(base, "profiles") };
    const saved = await loadProfile(p.name, options);
    assert.equal(saved.clientSource.file, join(base, "client.json"));
    assert.equal(saved.store.path, join(base, "tokens.json"));
    assert.equal((await profileStatus(p.name, options)).status, "saved");
    assert.equal(
      (await refreshProfile(p.name, {
        ...options, oauthFactory: fakeOAuth().factory,
      })).status,
      "saved",
    );
    assert.equal(
      (await profileEnvironment(p.name, options)).GRANTLOOM_REFRESH_TOKEN,
      "synthetic-refresh-token",
    );
    assert.equal(p.clientSource.file, "client.json");
    await assert.rejects(readFile(join(otherDir, "tokens.json")), { code: "ENOENT" });
  } finally {
    process.chdir(originalCwd);
    await session?.cancel();
  }
});
for (const error of [false, true])
  test(`disconnected callback releases listener after ${error ? "failed" : "saved"} completion`, async (t) => {
    let release, entered;
    const waiting = new Promise((r) => { release = r; });
    const called = new Promise((r) => { entered = r; });
    const fake = fakeOAuth({ wait: waiting, error });
    const factory = (options) => {
      const oauth = fake.factory(options), getToken = oauth.getToken;
      oauth.getToken = (request) => {
        entered();
        return getToken(request);
      };
      return oauth;
    };
    const { session } = await setup(t, { start: { oauthFactory: factory } });
    const req = request(callback(session));
    req.on("error", () => {});
    req.end();
    await called;
    const disconnected = new Promise((r) => req.once("close", r));
    req.destroy();
    await disconnected;
    // Let the server observe the socket close before verification finishes.
    await new Promise((r) => setTimeout(r, 20));
    release();
    assert.equal((await session.done).status, error ? "failed" : "saved");
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(Number(new URL(session.redirectUri).port), "127.0.0.1", resolve);
    });
    await new Promise((r) => probe.close(r));
  });

test("auth rejects a new store collision through permitted macOS system aliases", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = await realpath(await mkdtemp("/tmp/grantloom-auth-alias-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = profile(dir);
  p.store.path = join(dir.replace("/private/tmp/", "/tmp/"), p.name + ".json");
  const fake = fakeOAuth();
  await assert.rejects(async () => {
    const session = await startAuth(p, { env, configDir: dir, oauthFactory: fake.factory });
    await session.cancel();
  }, { code: "INVALID_CONFIG" });
  assert.equal(fake.oauth, undefined);
  await assert.rejects(readFile(join(dir, p.name + ".json")), { code: "ENOENT" });
});
