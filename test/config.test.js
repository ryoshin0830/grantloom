import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadClient, saveProfile, loadProfile } from "../src/config.js";
import { AppError, publicError } from "../src/errors.js";
const credential = {
  installed: {
    client_id: "test.apps.googleusercontent.com",
    client_secret: "synthetic",
    project_id: "test-project",
    redirect_uris: ["http://localhost"],
  },
};
const profile = {
  version: 1,
  name: "work",
  account: "test@example.com",
  clientSource: { env: "TEST_CLIENT" },
  store: { kind: "json", path: "/tmp/test-tokens.json" },
  scopes: ["openid", "email"],
};
test("client reads installed env, web file, and op fields", async () => {
  const env = { TEST_CLIENT: JSON.stringify(credential) };
  assert.deepEqual(await loadClient({ env: "TEST_CLIENT" }, { env }), {
    type: "installed",
    clientId: credential.installed.client_id,
    clientSecret: "synthetic",
    projectId: "test-project",
    redirectUris: ["http://localhost"],
  });
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  const file = join(dir, "client.json");
  await writeFile(file, JSON.stringify({ web: credential.installed }));
  assert.equal((await loadClient({ file })).type, "web");
  const calls = [];
  const client = await loadClient(
    { op: { vault: "test", item: "client", tokenEnv: "OP_TEST" } },
    {
      env: { OP_TEST: "synthetic-token" },
      op: async (args, options) => {
        calls.push({ args, options });
        return {
          fields: [
            { label: "client_id", value: "id" },
            { label: "client_secret", value: "synthetic" },
          ],
        };
      },
    },
  );
  assert.equal(client.clientId, "id");
  assert.equal(client.type, "installed");
  assert.equal(calls[0].options.tokenEnv, "OP_TEST");
});
test("invalid sources and client types fail safely", async () => {
  for (const source of [
    {},
    { env: "A", file: "B" },
    { env: "BAD-NAME" },
    { op: { vault: "v", item: "i", clientSecret: "secret" } },
  ])
    await assert.rejects(
      loadClient(source),
      (e) => e.code === "INVALID_CONFIG",
    );
  for (const value of [
    { type: "service_account" },
    { installed: { client_id: "id" } },
    { installed: credential.installed, web: credential.installed },
  ])
    await assert.rejects(
      loadClient({ env: "CLIENT" }, { env: { CLIENT: JSON.stringify(value) } }),
      (e) => e.code === "INVALID_CLIENT",
    );
  await assert.rejects(
    loadClient(
      { op: { vault: "v", item: "i" } },
      {
        op: async () => {
          throw Error("SECRET raw error");
        },
      },
    ),
    (e) => !e.message.includes("SECRET"),
  );
});
test("public errors never forward untrusted code or message", () => {
  assert.deepEqual(publicError(new Error("SECRET")), {
    code: "INTERNAL_ERROR",
    message: "The operation failed.",
  });
  assert.equal(
    publicError(new AppError("INVALID_CONFIG", "SECRET")).message,
    "Configuration is invalid.",
  );
  assert.equal(
    publicError(new AppError("SECRET", "SECRET")).code,
    "INTERNAL_ERROR",
  );
});
test("profiles round-trip with private modes and validated non-secret descriptors", async () => {
  const configDir = join(
    await mkdtemp(join(tmpdir(), "grantloom-")),
    "profiles",
  );
  await saveProfile(profile, { configDir });
  assert.deepEqual(await loadProfile("work", { configDir }), profile);
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(configDir, "work.json"))).mode & 0o777, 0o600);
  for (const name of ["../escape", "Work", "a/b", "a".repeat(64)])
    await assert.rejects(
      loadProfile(name, { configDir }),
      (e) => e.code === "INVALID_CONFIG",
    );
  for (const changed of [
    { ...profile, clientSource: { env: "CLIENT", secret: "SECRET" } },
    {
      ...profile,
      store: { kind: "json", path: "/tmp/a", access_token: "SECRET" },
    },
    { ...profile, tokens: { access_token: "SECRET" } },
  ])
    await assert.rejects(
      saveProfile(changed, { configDir }),
      (e) => e.code === "INVALID_CONFIG",
    );
  await writeFile(
    join(configDir, "work.json"),
    JSON.stringify({ ...profile, clientSecret: "SECRET" }),
    { mode: 0o600 },
  );
  await assert.rejects(loadProfile("work", { configDir }));
  assert.ok(
    !(await readFile(join(configDir, "work.json"), "utf8")).includes(
      "synthetic",
    ),
  );
});
test("profile symlink destination fails", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "grantloom-"));
  await symlink("/tmp/no-such-file", join(configDir, "work.json"));
  await assert.rejects(saveProfile(profile, { configDir }));
});
test("undefined or non-string descriptors cannot pass name validation", async () => {
  for (const source of [
    { env: undefined },
    { env: null },
    { op: { vault: "v", item: "i", tokenEnv: null } },
  ])
    await assert.rejects(
      loadClient(source),
      (e) => e.code === "INVALID_CONFIG",
    );
  const configDir = await mkdtemp(join(tmpdir(), "grantloom-"));
  for (const store of [
    { kind: "env", path: "/tmp/synthetic", prefix: null },
    { kind: "1password", vault: "v", title: "t", tokenEnv: null },
    { kind: "1password", vault: "v", title: "t", refreshField: "access_token" },
  ])
    await assert.rejects(
      saveProfile({ ...profile, store }, { configDir }),
      (e) => e.code === "INVALID_CONFIG",
    );
});
test("profile operations reject writable intermediate config ancestors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  const configDir = join(dir, "ancestor", "private");
  await saveProfile(profile, { configDir });
  const { chmod } = await import("node:fs/promises");
  await chmod(join(dir, "ancestor"), 0o777);
  await assert.rejects(
    saveProfile(profile, { configDir }),
    (e) => e.code === "STORE_UNSAFE",
  );
  await assert.rejects(
    loadProfile("work", { configDir }),
    (e) => e.code === "STORE_UNSAFE",
  );
});

test("profile save preserves existing non-profile bytes", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "grantloom-profile-collision-"));
  const path = join(configDir, "work.json");
  for (const original of [
    "synthetic arbitrary bytes",
    JSON.stringify(credential),
    JSON.stringify({ tokens: { refresh_token: "synthetic-refresh" } }),
  ]) {
    await writeFile(path, original, { mode: 0o600 });
    await assert.rejects(saveProfile(profile, { configDir }), { code: "INVALID_CONFIG" });
    assert.equal(await readFile(path, "utf8"), original);
  }
});
test("profile save normalizes persistent filesystem references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-profile-paths-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    await saveProfile(
      {
        ...profile,
        clientSource: { file: "client.json" },
        store: { kind: "env", path: "tokens.env" },
      },
      { configDir: "profiles" },
    );
    const saved = await loadProfile("work", { configDir: "profiles" });
    assert.equal(saved.clientSource.file, join(process.cwd(), "client.json"));
    assert.equal(saved.store.path, join(process.cwd(), "tokens.env"));
    assert.deepEqual(profile.clientSource, { env: "TEST_CLIENT" });
  } finally {
    process.chdir(originalCwd);
  }
});

test("unavailable Windows root fails safely with bounded lookup before OAuth starts", async () => {
  const script = `
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const require = createRequire(import.meta.url);
    const path = require("node:path"), fs = require("node:fs/promises");
    const { startAuth } = await import(${JSON.stringify(new URL("../src/auth.js", import.meta.url).href)});
    for (const key of ["join", "resolve", "dirname", "basename"])
      path[key] = path.win32[key];
    const requests = [];
    fs.realpath = async (file) => {
      requests.push(file);
      // Bound a regression's recursion so the test cannot itself hang.
      throw Object.assign(new Error("synthetic unavailable drive"), {
        code: requests.length > 3 ? "EIO" : "ENOENT",
      });
    };
    syncBuiltinESMExports();
    let oauthStarts = 0;
    try {
      await startAuth({
        version: 1, name: "synthetic", account: "you@example.com",
        clientSource: { env: "TEST_CLIENT" }, scopes: ["openid", "email"],
        store: { kind: "1password", vault: "synthetic-vault", item: "synthetic-item" },
      }, {
        configDir: ${JSON.stringify("Z:\\missing")},
        oauthFactory: () => { oauthStarts++; },
      });
      throw new Error("Unexpected synthetic auth success");
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code, message: error.message, requests, oauthStarts }));
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    "--input-type=module", "-e", script,
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.code, "STORE_UNSAFE");
  assert.equal(result.message, "Storage permissions or path are unsafe.");
  assert.deepEqual(result.requests, [
    "Z:\\missing\\synthetic.json", "Z:\\missing", "Z:\\",
  ]);
  assert.equal(result.oauthStarts, 0);
  assert.equal(stderr, "");
});
