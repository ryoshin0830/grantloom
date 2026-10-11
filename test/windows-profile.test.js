import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { saveProfile, loadProfile } from "../src/config.js";
import { createStore } from "../src/stores.js";
const profile = {
  version: 1,
  name: "windows",
  account: "you@example.com",
  clientSource: {
    op: {
      vault: "CLIENT_VAULT_ID",
      item: "CLIENT_ITEM_ID",
      clientIdField: "username",
      clientSecretField: "credential",
    },
  },
  store: { kind: "1password", vault: "TOKEN_VAULT_ID", item: "TOKEN_ITEM_ID" },
  scopes: ["gmail.readonly"],
};
async function setup(t) {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "grantloom-windows-profile-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", original));
  return dir;
}
test("Windows nonsecret 1Password profile descriptors round-trip and replace atomically", async (t) => {
  const dir = await setup(t);
  const configDir = join(dir, "profiles");
  await saveProfile(profile, { configDir });
  assert.deepEqual(await loadProfile(profile.name, { configDir }), profile);
  const changed = { ...profile, scopes: ["calendar.readonly"] };
  await saveProfile(changed, { configDir });
  assert.deepEqual(await loadProfile(profile.name, { configDir }), changed);
  const text = await readFile(join(configDir, "windows.json"), "utf8");
  assert(!text.includes("access_token"));
  assert(!text.includes("client_secret"));
});
test("Windows descriptor validation and profile name confinement remain enforced", async (t) => {
  const dir = await setup(t);
  for (const name of [
    "../escape",
    "..\\escape",
    "a/b",
    "a\\b",
    "Bad",
    "a".repeat(64),
  ]) {
    await assert.rejects(
      saveProfile({ ...profile, name }, { configDir: dir }),
      (e) => e.code === "INVALID_CONFIG",
    );
    await assert.rejects(
      loadProfile(name, { configDir: dir }),
      (e) => e.code === "INVALID_CONFIG",
    );
  }
  for (const changed of [
    { ...profile, tokens: { access_token: "synthetic-access-token" } },
    {
      ...profile,
      clientSource: { env: "CLIENT", clientSecret: "synthetic-client-secret" },
    },
    {
      ...profile,
      store: { ...profile.store, refresh_token: "synthetic-refresh-token" },
    },
  ])
    await assert.rejects(
      saveProfile(changed, { configDir: dir }),
      (e) => e.code === "INVALID_CONFIG",
    );
  await saveProfile(profile, { configDir: dir });
  await writeFile(
    join(dir, "windows.json"),
    JSON.stringify({ ...profile, clientSecret: "synthetic-client-secret" }),
  );
  await assert.rejects(
    loadProfile(profile.name, { configDir: dir }),
    (e) => e.code === "INVALID_CONFIG",
  );
});
test("Windows profile directory symlinks/junctions are rejected for reads and writes", async (t) => {
  const dir = await setup(t);
  const real = join(dir, "real");
  await mkdir(real);
  await saveProfile(profile, { configDir: real });
  const link = join(dir, "junction");
  await symlink(real, link, "junction");
  await assert.rejects(
    saveProfile(profile, { configDir: link }),
    (e) => e.code === "STORE_UNSAFE",
  );
  await assert.rejects(
    loadProfile(profile.name, { configDir: link }),
    (e) => e.code === "STORE_UNSAFE",
  );
  assert.deepEqual(
    await loadProfile(profile.name, { configDir: real }),
    profile,
  );
});
test("Windows metadata path does not permit JSON/env credential stores", async (t) => {
  const dir = await setup(t);
  for (const kind of ["json", "env"]) {
    const store = createStore({ kind, path: join(dir, `tokens.${kind}`) });
    await assert.rejects(
      store.preflight(),
      (e) => e.code === "FILE_STORE_UNSUPPORTED",
    );
    await assert.rejects(
      store.read(),
      (e) => e.code === "FILE_STORE_UNSUPPORTED",
    );
  }
});
test("Windows-targeted CLI help works without credentials", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    resolve("bin/grantloom.js"),
    "--help",
  ]);
  assert.match(stdout, /grantloom/);
  assert.match(stdout, /1password/);
  assert.equal(stderr, "");
});

test("Windows profile save preserves non-profile bytes", async (t) => {
  const configDir = await setup(t);
  const path = join(configDir, profile.name + ".json");
  const original = "synthetic unrelated descriptor bytes";
  await writeFile(path, original);
  await assert.rejects(saveProfile(profile, { configDir }), { code: "INVALID_CONFIG" });
  assert.equal(await readFile(path, "utf8"), original);
});
