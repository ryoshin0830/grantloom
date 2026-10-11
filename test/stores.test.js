import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/stores.js";
const record = {
  version: 1,
  account: "test@example.com",
  client: {
    clientId: "synthetic-id",
    clientSecret: "quotes'\"\n$`\\synthetic",
  },
  requestedScopes: ["openid", "email"],
  grantedScopes: ["email", "openid"],
  tokens: {
    access_token: "access'\"\n$`\\synthetic",
    refresh_token: "refresh'\"\n$`\\synthetic",
    expiry_date: 2000000000000,
  },
  obtainedAt: "2026-10-11T00:00:00Z",
  verifiedAt: "2026-10-11T00:00:01Z",
};
for (const kind of ["json", "env"]) {
  test(`${kind} round-trip is private, atomic, and protects account/client/scopes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
    const path = join(dir, "tokens");
    const store = createStore({ kind, path, prefix: "GRANTLOOM_TEST" });
    await store.preflight();
    assert.deepEqual(await store.write(record), { kind, path });
    assert.deepEqual(await store.read(), record);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const before = await readFile(path, "utf8");
    for (const changed of [
      { ...record, account: "other@example.com" },
      { ...record, client: { ...record.client, clientId: "other" } },
      { ...record, requestedScopes: ["openid"] },
    ])
      await assert.rejects(
        store.write(changed),
        (e) => e.code === "STORE_CONFLICT",
      );
    await assert.rejects(
      store.write({ ...record, tokens: {} }),
      (e) => e.code === "INVALID_RECORD",
    );
    assert.equal(await readFile(path, "utf8"), before);
    await chmod(path, 0o644);
    await assert.rejects(store.read(), (e) => e.code === "STORE_UNSAFE");
    await assert.rejects(store.write(record), (e) => e.code === "STORE_UNSAFE");
  });
  test(`${kind} refuses symlinks and unsafe directories`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
    const path = join(dir, "tokens");
    await symlink("/tmp/missing-target", path);
    await assert.rejects(createStore({ kind, path }).preflight());
    await chmod(dir, 0o755);
    await assert.rejects(
      createStore({ kind, path: join(dir, "other") }).preflight(),
    );
  });
}
test("env read never evaluates shell expressions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  const path = join(dir, "tokens");
  await writeFile(
    path,
    "export GRANTLOOM_ACCESS_TOKEN=$(touch /tmp/grantloom-should-never-run)\n",
    { mode: 0o600 },
  );
  await assert.rejects(
    createStore({ kind: "env", path }).read(),
    (e) => e.code === "INVALID_RECORD",
  );
});
function fakeOp(items = []) {
  const calls = [];
  return {
    calls,
    items,
    op: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === "vault") return { id: "v" };
      if (args[1] === "list")
        return items.map(({ id, title }) => ({ id, title }));
      if (args[1] === "get") {
        const item = items.find((i) => i.id === args[2]);
        if (!item) throw Error("synthetic SECRET");
        return structuredClone(item);
      }
      if (["create", "edit"].includes(args[1])) {
        const item = {
          ...structuredClone(options.input),
          id: args[1] === "edit" ? args[2] : "stable-id",
        };
        const index = items.findIndex((i) => i.id === item.id);
        if (index < 0) items.push(item);
        else items[index] = item;
        return item;
      }
      throw Error("unexpected command");
    },
  };
}
test("1password uses concealed stdin fields, child token config, stable ID, and preserves unknown fields", async () => {
  const fake = fakeOp();
  const store = createStore(
    {
      kind: "1password",
      vault: "test-vault",
      title: "test-item",
      tokenEnv: "OP_TEST",
    },
    { env: { OP_TEST: "synthetic" }, op: fake.op },
  );
  await store.preflight();
  assert.deepEqual(await store.write(record), {
    kind: "1password",
    vault: "test-vault",
    item: "stable-id",
  });
  assert.deepEqual(await store.read(), record);
  fake.items[0].fields.push({
    id: "extra",
    label: "extra",
    type: "STRING",
    value: "keep",
  });
  await store.write({
    ...record,
    tokens: { ...record.tokens, access_token: "updated" },
  });
  const write = fake.calls.find((c) => c.args[1] === "create");
  assert.equal(write.options.tokenEnv, "OP_TEST");
  assert.ok(
    write.options.input.fields
      .filter((f) =>
        ["client_secret", "access_token", "refresh_token"].includes(f.label),
      )
      .every((f) => f.type === "CONCEALED"),
  );
  assert.ok(!write.args.join(" ").includes(record.tokens.access_token));
  assert.equal(fake.items.length, 1);
  assert.ok(fake.items[0].fields.some((f) => f.label === "extra"));
  await assert.rejects(
    store.write({ ...record, account: "other@example.com" }),
    (e) => e.code === "STORE_CONFLICT",
  );
});
test("1password rejects duplicate titles, missing IDs, and captures errors", async () => {
  await assert.rejects(
    createStore(
      { kind: "1password", vault: "v", title: "same" },
      {
        op: fakeOp([
          { id: "1", title: "same" },
          { id: "2", title: "same" },
        ]).op,
      },
    ).preflight(),
    (e) => e.code === "STORE_AMBIGUOUS",
  );
  await assert.rejects(
    createStore(
      { kind: "1password", vault: "v", item: "missing" },
      { op: fakeOp().op },
    ).preflight(),
    (e) => e.code === "OP_FAILED",
  );
  await assert.rejects(
    createStore(
      { kind: "1password", vault: "v", title: "new" },
      {
        op: async () => {
          throw Error(record.tokens.access_token);
        },
      },
    ).preflight(),
    (e) => !e.message.includes(record.tokens.access_token),
  );
});
test("1password post-write readback mismatch fails", async () => {
  const fake = fakeOp();
  const store = createStore(
    { kind: "1password", vault: "v", title: "test" },
    {
      op: async (args, options) => {
        const result = await fake.op(args, options);
        if (args[1] === "get")
          result.fields.find((f) => f.label === "access_token").value =
            "tampered";
        return result;
      },
    },
  );
  await assert.rejects(store.write(record), (e) => e.code === "STORE_MISMATCH");
});
test("1password creation explicitly consumes stdin and reads concealed fields", async () => {
  const fake = fakeOp();
  await createStore(
    { kind: "1password", vault: "v", title: "new" },
    { op: fake.op },
  ).write(record);
  assert.ok(fake.calls.find((c) => c.args[1] === "create").args.includes("-"));
  assert.ok(
    fake.calls
      .filter((c) => c.args[1] === "get")
      .every((c) => c.args.includes("--reveal")),
  );
});
test("preflight cannot cache absence of a matching 1password item", async () => {
  const fake = fakeOp();
  const store = createStore(
    { kind: "1password", vault: "v", title: "new" },
    { op: fake.op },
  );
  await store.preflight();
  const other = createStore(
    { kind: "1password", vault: "v", title: "new" },
    { op: fake.op },
  );
  await other.write({ ...record, account: "other@example.com" });
  await assert.rejects(store.write(record), (e) => e.code === "STORE_CONFLICT");
  assert.equal(fake.items.length, 1);
});
test("reading file credentials rejects an unsafe parent directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  const store = createStore({ kind: "json", path: join(dir, "tokens") });
  await store.write(record);
  await chmod(dir, 0o755);
  await assert.rejects(store.read(), (e) => e.code === "STORE_UNSAFE");
});
test("file write creates a fresh private nested destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  const store = createStore({
    kind: "json",
    path: join(dir, "nested", "tokens"),
  });
  await store.write(record);
  assert.deepEqual(await store.read(), record);
  assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
});
test("concurrent file writers cannot silently overwrite another account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  for (let i = 0; i < 30; i++) {
    const path = join(dir, `tokens-${i}`);
    const results = await Promise.allSettled([
      createStore({ kind: "json", path }).write(record),
      createStore({ kind: "json", path }).write({
        ...record,
        account: "other@example.com",
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  }
});
test("Windows file stores fail explicitly while 1password remains available", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await assert.rejects(
      createStore({ kind: "json", path: "synthetic-tokens" }).preflight(),
      (e) => e.code === "FILE_STORE_UNSUPPORTED",
    );
    await createStore(
      { kind: "1password", vault: "v", title: "test" },
      { op: fakeOp().op },
    ).preflight();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
