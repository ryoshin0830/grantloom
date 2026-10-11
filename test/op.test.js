import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOp } from "../src/op.js";
test("op transport passes JSON on stdin and service token in child environment only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  await writeFile(
    join(dir, "op"),
    `#!${process.execPath}\nlet data='';for await(const chunk of process.stdin)data+=chunk;process.stderr.write('synthetic SECRET stderr');process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:JSON.parse(data),token:process.env.OP_SERVICE_ACCOUNT_TOKEN}));\n`,
    { mode: 0o700 },
  );
  const env = { PATH: dir, OP_TEST: "synthetic-token" };
  const result = await runOp(["item", "create", "-"], {
    env,
    tokenEnv: "OP_TEST",
    input: { fields: [{ value: "synthetic-secret" }] },
  });
  assert.deepEqual(result.args, ["item", "create", "-"]);
  assert.equal(result.input.fields[0].value, "synthetic-secret");
  assert.equal(result.token, "synthetic-token");
  assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
});
test("op exit and malformed output are captured as fixed errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-"));
  for (const body of [
    "process.stdout.write('synthetic SECRET');process.stderr.write('synthetic SECRET');process.exit(1);",
    "process.stdout.write('synthetic SECRET');",
  ]) {
    await writeFile(join(dir, "op"), `#!${process.execPath}\n${body}\n`, {
      mode: 0o700,
    });
    await assert.rejects(
      runOp(["item", "get", "id"], { env: { PATH: dir } }),
      (e) => e.code === "OP_FAILED" && !e.message.includes("SECRET"),
    );
  }
  await assert.rejects(
    runOp([], { env: { PATH: dir }, tokenEnv: "MISSING" }),
    (e) => e.code === "OP_FAILED",
  );
});
