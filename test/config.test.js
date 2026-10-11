import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
