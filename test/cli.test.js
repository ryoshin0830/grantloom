import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCLI } from "../src/cli.js";
import { createStore } from "../src/stores.js";
import { saveProfile } from "../src/config.js";
import {
  profile,
  env,
  scopes,
  clientId,
  clientSecret,
} from "../fixtures/oauth.js";
const bin = resolve("bin/grantloom.js");
const markers = [
  "synthetic-client-secret",
  "synthetic-access-token",
  "synthetic-refresh-token",
  "synthetic-code",
];
function clean(value) {
  for (const s of markers) assert(!JSON.stringify(value).includes(s));
}
function child(args, options = {}) {
  const p = spawn(process.execPath, args, {
    env: { ...process.env, ...env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  p.stdout.on("data", (b) => {
    stdout += b;
    options.onOutput?.(b.toString(), p);
  });
  p.stderr.on("data", (b) => {
    stderr += b;
    options.onOutput?.(b.toString(), p);
  });
  return {
    p,
    done: new Promise((resolve, reject) => {
      p.on("error", reject);
      p.on("close", (code, signal) =>
        resolve({ code, signal, stdout, stderr }),
      );
    }),
  };
}
const cli = (args, options) => child([bin, ...args], options).done;
async function setup(t, expired = false) {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = profile(dir);
  await createStore(p.store).write({
    version: 1,
    account: p.account,
    client: { clientId, clientSecret },
    requestedScopes: scopes,
    grantedScopes: scopes,
    tokens: {
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      expiry_date: Date.now() + (expired ? -1 : 3600000),
    },
    obtainedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
  });
  await saveProfile(p, { configDir: join(dir, "profiles") });
  return { dir, p, env: { GRANTLOOM_CONFIG_DIR: join(dir, "profiles") } };
}
test("subprocess help and version expose commands without credentials", async () => {
  for (const args of [["--help"], ["auth", "--help"], ["--version"]]) {
    const r = await cli(args);
    assert.equal(r.code, 0);
    clean(r);
    assert.match(
      r.stdout,
      args.includes("--version") ? /0\.1\.0/ : /grantloom/,
    );
  }
});
test("invalid flags, commands, secret literals and missing noninteractive descriptors fail safely", async () => {
  for (const args of [
    ["unknown"],
    ["auth"],
    ["auth", "--account", "you@example.com"],
    ["auth", "--client-secret", "synthetic-client-secret"],
    ["auth", "--client-env", "synthetic-client-secret"],
    ["status", "--account", "you@example.com"],
    ["auth", "--test"],
    ["exec", "--profile", "synthetic"],
  ]) {
    const r = await cli([...args, "--json"]);
    assert.equal(r.code, 2);
    assert.deepEqual(JSON.parse(r.stdout), {
      code: "INVALID_CONFIG",
      message: "Configuration is invalid.",
    });
    clean(r);
  }
});
test("scope listing JSON is metadata only and labels API state unverified", async () => {
  const r = await cli(["scopes", "--json"]);
  assert.equal(r.code, 0);
  const v = JSON.parse(r.stdout);
  assert.equal(v.enabledStatus, "unverified");
  assert(v.candidates.some((c) => c.uri === "https://mail.google.com/"));
  clean(r);
});
test("status reads real private profile and prints metadata only", async (t) => {
  const f = await setup(t);
  const r = await cli(["status", "--profile", f.p.name, "--json"], f);
  assert.equal(r.code, 0);
  const v = JSON.parse(r.stdout);
  assert.equal(v.account, f.p.account);
  assert.equal(v.status, "saved");
  assert.deepEqual(v.storage, { kind: "json", path: f.p.store.path });
  clean(r);
});
test("malformed client source fails before consent without echoing file content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grantloom-malformed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "client.json");
  await writeFile(file, "synthetic-client-secret");
  const r = await cli([
    "auth",
    "--client-json",
    file,
    "--account",
    "you@example.com",
    "--scope",
    "gmail.full",
    "--store",
    "json",
    "--output",
    join(dir, "tokens.json"),
    "--profile",
    "synthetic",
    "--no-open",
    "--json",
  ]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "INVALID_CLIENT");
  clean(r);
});
test("exec passes exact args and named environment without shell, propagates child exit", async (t) => {
  const f = await setup(t);
  const script =
    "console.log(process.env.GRANTLOOM_ACCESS_TOKEN && process.env.GRANTLOOM_REFRESH_TOKEN && process.env.GRANTLOOM_CLIENT_SECRET && process.argv[1] === '$(echo leaked); *' ? 'yes' : 'no'); process.exit(7)";
  const r = await cli(
    [
      "exec",
      "--profile",
      f.p.name,
      "--",
      process.execPath,
      "-e",
      script,
      "$(echo leaked); *",
    ],
    f,
  );
  assert.equal(r.code, 7);
  assert.equal(r.stdout, "yes\n");
  clean(r);
});
test("expired exec returns fixed refresh guidance", async (t) => {
  const f = await setup(t, true);
  const r = await cli(
    [
      "exec",
      "--profile",
      f.p.name,
      "--json",
      "--",
      process.execPath,
      "-e",
      "process.exit(99)",
    ],
    f,
  );
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).code, "TOKEN_EXPIRED");
  clean(r);
});
test("programmatic refresh malicious dependency errors are redacted", async () => {
  let out = "";
  const stream = {
    write: (s) => {
      out += s;
    },
  };
  const code = await runCLI(["refresh", "--profile", "synthetic", "--json"], {
    output: stream,
    error: stream,
    services: {
      refreshProfile: async () => {
        throw new Error(markers.join(" "));
      },
    },
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).code, "INTERNAL_ERROR");
  clean(out);
});
test("interactive CLI asks descriptors in order and retries same verified session", async (t) => {
  let text = "";
  let supplied = 0;
  const answers = [
    "env",
    "TEST_CLIENT",
    "student@example.com",
    "https://www.googleapis.com/auth/tasks.readonly",
    "json",
    null,
    "synthetic",
    "retry",
  ];
  const f = await setup(t);
  answers[5] = join(f.dir, "new.json");
  const r = child([resolve("fixtures/cli.js"), "interactive"], {
    env: f.env,
    onOutput(s, p) {
      text += s;
      const prompts = [
        "Client source",
        "Client JSON variable",
        "Google account",
        "Scopes",
        "Store kind",
        "Destination path",
        "Profile name",
        "Save failed",
      ];
      for (let i = supplied; i < prompts.length; i++) {
        if (text.includes(prompts[i])) {
          p.stdin.write(answers[i] + "\n");
          supplied++;
        } else break;
      }
    },
  });
  const result = await r.done;
  assert.equal(result.code, 0);
  assert.equal(supplied, 8);
  assert.match(result.stderr, /"enabledStatus":"unverified"/);
  assert.match(result.stdout, /"status":"saved"/);
  clean(result);
});
test("SIGINT cancels live callback and leaves no stored profile", async (t) => {
  const f = await setup(t);
  let killed = false;
  const r = child([resolve("fixtures/cli.js"), "cancel", f.dir], {
    env: f.env,
    onOutput(s, p) {
      if (s.includes("READY") && !killed) {
        killed = true;
        p.kill("SIGINT");
      }
    },
  });
  const result = await r.done;
  assert.equal(result.code, 130);
  assert.match(result.stdout, /"status":"cancelled"/);
  clean(result);
});
test("auth lists shared catalog with explicit Cloud flags and never adds Cloud scope", async (t) => {
  const f = await setup(t);
  let output = "",
    error = "",
    catalog;
  const fake = (await import("../fixtures/oauth.js")).fakeOAuth();
  const code = await runCLI(
    [
      "auth",
      "--client-env",
      "TEST_CLIENT",
      "--account",
      f.p.account,
      "--scope",
      f.p.scopes[0],
      "--store",
      "json",
      "--output",
      join(f.dir, "catalog.json"),
      "--profile",
      "catalog",
      "--project-id",
      "synthetic-project",
      "--cloud-token-env",
      "TEST_CLOUD",
      "--json",
    ],
    {
      env: { ...env, TEST_CLOUD: "synthetic-cloud-token" },
      output: {
        write: (s) => {
          output += s;
        },
      },
      error: {
        write: (s) => {
          error += s;
        },
      },
      authOptions: {
        configDir: join(f.dir, "profiles"),
        oauthFactory: fake.factory,
      },
      services: {
        listScopes: async (options) => {
          catalog = options;
          return {
            enabledStatus: "verified",
            enabledApis: ["tasks.googleapis.com"],
            candidates: [
              {
                uri: f.p.scopes[0],
                label: "Read tasks",
                api: "tasks.googleapis.com",
                enabledStatus: "enabled",
              },
            ],
          };
        },
      },
      open: async (url) => {
        const u = new URL(url);
        const cb = new URL(u.searchParams.get("redirect_uri"));
        cb.searchParams.set("state", u.searchParams.get("state"));
        cb.searchParams.set("code", "synthetic-code");
        await fetch(cb);
        return false;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(catalog.projectId, "synthetic-project");
  assert.equal(catalog.cloudTokenEnv, "TEST_CLOUD");
  assert.match(error, /"enabledStatus":"verified"/);
  assert.deepEqual(JSON.parse(output).requestedScopes, scopes);
  clean(output);
  clean(error);
  assert(!error.includes("synthetic-cloud-token"));
});
test("op custom field flags and distinct vault map to retained source/store descriptors", async () => {
  let captured;
  let output = "";
  const saved = {
    status: "saved",
    account: "you@example.com",
    requestedScopes: ["openid", "email"],
    grantedScopes: ["openid", "email"],
    expiresAt: null,
    storage: {
      kind: "1password",
      vault: "destination-vault",
      item: "stable-id",
    },
  };
  const code = await runCLI(
    [
      "auth",
      "--client-op-item",
      "client-id",
      "--op-vault",
      "client-vault",
      "--op-token-env",
      "NAMED_OP",
      "--client-id-field",
      "username",
      "--client-secret-field",
      "credential",
      "--client-project-field",
      "project",
      "--client-type",
      "installed",
      "--account",
      "you@example.com",
      "--scope",
      "email",
      "--store",
      "1password",
      "--store-vault",
      "destination-vault",
      "--title",
      "Synthetic tokens",
      "--profile",
      "synthetic",
      "--no-open",
    ],
    {
      env: { NAMED_OP: "synthetic-op-token" },
      output: {
        write: (s) => {
          output += s;
        },
      },
      error: { write: () => {} },
      services: {
        loadClient: async () => ({ projectId: "synthetic-project" }),
        listScopes: async () => ({
          enabledStatus: "unverified",
          enabledApis: [],
          candidates: [],
        }),
        startAuth: async (p) => {
          captured = p;
          return {
            id: "synthetic",
            url: "https://accounts.google.com/o/oauth2/v2/auth",
            done: Promise.resolve(saved),
            status: () => saved,
            cancel: async () => saved,
          };
        },
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(captured.clientSource, {
    op: {
      vault: "client-vault",
      item: "client-id",
      tokenEnv: "NAMED_OP",
      clientIdField: "username",
      clientSecretField: "credential",
      projectIdField: "project",
      type: "installed",
    },
  });
  assert.deepEqual(captured.store, {
    kind: "1password",
    vault: "destination-vault",
    title: "Synthetic tokens",
    tokenEnv: "NAMED_OP",
  });
  clean(output);
  assert(!output.includes("synthetic-op-token"));
});
test("failed or unresolved browser opener leaves pending callback cancellable", async (t) => {
  const f = await setup(t);
  const { EventEmitter } = await import("node:events");
  for (const unresolved of [false, true]) {
    const signals = new EventEmitter();
    let out = "";
    const fake = (await import("../fixtures/oauth.js")).fakeOAuth();
    const code = await runCLI(
      [
        "auth",
        "--client-env",
        "TEST_CLIENT",
        "--account",
        f.p.account,
        "--scope",
        f.p.scopes[0],
        "--store",
        "json",
        "--output",
        join(f.dir, "opener.json"),
        "--profile",
        "opener",
      ],
      {
        env,
        signals,
        output: {
          write: (s) => {
            out += s;
          },
        },
        error: { write: () => {} },
        authOptions: {
          configDir: join(f.dir, "profiles"),
          oauthFactory: fake.factory,
        },
        open: () => {
          setImmediate(() => signals.emit("SIGINT"));
          return unresolved
            ? new Promise(() => {})
            : Promise.reject(new Error(markers.join(" ")));
        },
      },
    );
    assert.equal(code, 130);
    assert.equal(JSON.parse(out).status, "cancelled");
    clean(out);
  }
});
test("Cloud variable flags reject literal secrets even without project metadata", async () => {
  for (const args of [
    ["scopes", "--cloud-token-env", "synthetic-access-token"],
    ["scopes", "--op-token-env", "synthetic-refresh-token"],
  ]) {
    const r = await cli([...args, "--json"]);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).code, "INVALID_CONFIG");
    clean(r);
  }
});
test("subprocess refresh uses shared service and redacts malicious SDK failure", async (t) => {
  const f = await setup(t);
  const r = await child([resolve("fixtures/cli.js"), "refresh"], { env: f.env })
    .done;
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).code, "OAUTH_FAILED");
  clean(r);
  assert.equal(
    (await createStore(f.p.store).read()).tokens.access_token,
    "synthetic-access-token",
  );
});
test("CLI SIGINT waits for persistence already started and reports successful commit", async (t) => {
  const f = await setup(t);
  const { EventEmitter } = await import("node:events");
  const signals = new EventEmitter();
  const store = createStore({ kind: "json", path: join(f.dir, "commit.json") });
  const fake = (await import("../fixtures/oauth.js")).fakeOAuth();
  let output = "",
    wrote = false;
  const blocking = {
    ...store,
    write: async (record) => {
      await new Promise((r) => setImmediate(r));
      signals.emit("SIGINT");
      await new Promise((r) => setImmediate(r));
      assert.equal(output, "");
      const reference = await store.write(record);
      wrote = true;
      return reference;
    },
  };
  const code = await runCLI(
    [
      "auth",
      "--client-env",
      "TEST_CLIENT",
      "--account",
      f.p.account,
      "--scope",
      f.p.scopes[0],
      "--store",
      "json",
      "--output",
      join(f.dir, "commit.json"),
      "--profile",
      "commit",
    ],
    {
      env,
      signals,
      output: {
        write: (s) => {
          output += s;
        },
      },
      error: { write: () => {} },
      authOptions: {
        configDir: join(f.dir, "profiles"),
        oauthFactory: fake.factory,
        store: blocking,
      },
      open: async (url) => {
        const u = new URL(url);
        const cb = new URL(u.searchParams.get("redirect_uri"));
        cb.searchParams.set("state", u.searchParams.get("state"));
        cb.searchParams.set("code", "synthetic-code");
        await fetch(cb).catch(() => {});
        return false;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(wrote, true);
  assert.equal(JSON.parse(output).status, "saved");
  clean(output);
});
test("noninteractive CLI save failure reports safe metadata then cancels retained session", async (t) => {
  const f = await setup(t);
  const store = createStore({ kind: "json", path: join(f.dir, "fail.json") });
  const fake = (await import("../fixtures/oauth.js")).fakeOAuth();
  let output = "",
    url;
  const code = await runCLI(
    [
      "auth",
      "--client-env",
      "TEST_CLIENT",
      "--account",
      f.p.account,
      "--scope",
      f.p.scopes[0],
      "--store",
      "json",
      "--output",
      join(f.dir, "fail.json"),
      "--profile",
      "failed",
    ],
    {
      env,
      output: {
        write: (s) => {
          output += s;
        },
      },
      error: { write: () => {} },
      authOptions: {
        configDir: join(f.dir, "profiles"),
        oauthFactory: fake.factory,
        store: {
          ...store,
          write: async () => {
            throw new Error(markers.join(" "));
          },
        },
      },
      open: async (consent) => {
        const u = new URL(consent);
        url = u.searchParams.get("redirect_uri");
        const cb = new URL(url);
        cb.searchParams.set("state", u.searchParams.get("state"));
        cb.searchParams.set("code", "synthetic-code");
        await fetch(cb).catch(() => {});
        return false;
      },
    },
  );
  assert.equal(code, 1);
  assert.equal(JSON.parse(output).status, "save-failed");
  clean(output);
  await assert.rejects(fetch(url));
});
test("slow browser launcher cannot keep completed CLI alive and receives exact URL without shell", async (t) => {
  const { readFile, chmod } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "grantloom-opener-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "opened.json");
  const executable = join(dir, "xdg-open");
  await writeFile(
    executable,
    `#!/usr/bin/env node\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));setTimeout(()=>{},2500);\n`,
  );
  await chmod(executable, 0o700);
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic&scope=email";
  const script = `import {openBrowser} from ${JSON.stringify(pathToFileURL(resolve("src/cli.js")).href)};openBrowser(${JSON.stringify(url)},{platform:'linux'});`;
  const began = Date.now();
  const r = await child(["--input-type=module", "-e", script], {
    env: { PATH: `${dir}:${process.env.PATH}` },
  }).done;
  const elapsed = Date.now() - began;
  let info;
  for (let i = 0; i < 100; i++) {
    try {
      info = JSON.parse(await readFile(file, "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  assert(info);
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {}
  assert.equal(r.code, 0);
  assert.deepEqual(info.args, [url]);
  assert(elapsed < 2000, `launcher held process for ${elapsed}ms`);
  clean(r);
});
for (const early of [false, true])
  test(`interactive descriptor EOF${early ? " before prompt" : ""} cancels without hanging or leaking listeners`, async () => {
    const { PassThrough } = await import("node:stream");
    const { EventEmitter, once } = await import("node:events");
    const input = new PassThrough();
    input.isTTY = true;
    const error = new PassThrough();
    const signals = new EventEmitter();
    let output = "";
    if (early) {
      input.resume();
      const ended = once(input, "end");
      input.end();
      await ended;
    } else error.on("data", () => input.end());
    const running = runCLI(["auth", "--json"], {
      input,
      error,
      signals,
      output: {
        write: (s) => {
          output += s;
        },
      },
    });
    let timer;
    const timeout = new Promise((r) => {
      timer = setTimeout(() => r("timeout"), 100);
    });
    try {
      const code = await Promise.race([running, timeout]);
      assert.equal(code, 130);
      assert.deepEqual(JSON.parse(output), {
        code: "AUTH_CANCELLED",
        message: "Authentication was cancelled.",
      });
      clean(output);
      assert.equal(signals.listenerCount("SIGINT"), 0);
      assert.equal(input.listenerCount("end"), 0);
    } finally {
      clearTimeout(timer);
      signals.emit("SIGINT");
      await running;
      error.destroy();
      input.destroy();
    }
  });
test("EOF at actual save-failed retry prompt clears retained verification and closes callback", async (t) => {
  const f = await setup(t);
  const { PassThrough } = await import("node:stream");
  const { EventEmitter } = await import("node:events");
  const { startAuth } = await import("../src/auth.js");
  const { fakeOAuth } = await import("../fixtures/oauth.js");
  const input = new PassThrough();
  input.isTTY = true;
  const error = new PassThrough();
  const signals = new EventEmitter();
  let output = "",
    session,
    cancels = 0;
  error.on("data", (s) => {
    if (s.toString().includes("Save failed.")) input.end();
  });
  const store = createStore({ kind: "json", path: join(f.dir, "eof.json") });
  const running = runCLI(
    [
      "auth",
      "--client-env",
      "TEST_CLIENT",
      "--account",
      f.p.account,
      "--scope",
      f.p.scopes[0],
      "--store",
      "json",
      "--output",
      join(f.dir, "eof.json"),
      "--profile",
      "eof",
      "--json",
    ],
    {
      env,
      input,
      error,
      signals,
      output: {
        write: (s) => {
          output += s;
        },
      },
      authOptions: {
        configDir: join(f.dir, "profiles"),
        oauthFactory: fakeOAuth().factory,
        store: {
          ...store,
          write: async () => {
            throw new Error(markers.join(" "));
          },
        },
      },
      services: {
        startAuth: async (...args) => {
          session = await startAuth(...args);
          return {
            ...session,
            cancel: () => {
              cancels++;
              return session.cancel();
            },
          };
        },
      },
      open: async (url) => {
        const u = new URL(url);
        const cb = new URL(u.searchParams.get("redirect_uri"));
        cb.searchParams.set("state", u.searchParams.get("state"));
        cb.searchParams.set("code", "synthetic-code");
        await fetch(cb).catch(() => {});
        return false;
      },
    },
  );
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r("timeout"), 250);
  });
  try {
    const code = await Promise.race([running, timeout]);
    assert.equal(code, 130);
    assert.equal(cancels, 1);
    assert.equal(JSON.parse(output).status, "cancelled");
    assert.equal(session.status().status, "cancelled");
    await assert.rejects(session.retrySave());
    await assert.rejects(fetch(session.redirectUri));
    clean(output);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(input.listenerCount("end"), 0);
  } finally {
    clearTimeout(timer);
    signals.emit("SIGINT");
    await running;
    await session?.cancel();
    error.destroy();
    input.destroy();
  }
});
test("interactive EOF during an already-started commit waits and reports saved", async (t) => {
  const f = await setup(t);
  const { PassThrough } = await import("node:stream");
  const { EventEmitter } = await import("node:events");
  const { fakeOAuth } = await import("../fixtures/oauth.js");
  const input = new PassThrough();
  input.isTTY = true;
  const error = new PassThrough();
  const signals = new EventEmitter();
  let output = "",
    ended = false;
  error.on("data", (s) => {
    if (s.toString().includes("Profile name:")) input.write("eof-commit\n");
  });
  const store = createStore({
    kind: "json",
    path: join(f.dir, "eof-commit.json"),
  });
  const blocking = {
    ...store,
    write: async (record) => {
      await new Promise((r) => setImmediate(r));
      input.end();
      await new Promise((r) => setImmediate(r));
      ended = true;
      assert.equal(output, "");
      return store.write(record);
    },
  };
  const code = await runCLI(
    [
      "auth",
      "--client-env",
      "TEST_CLIENT",
      "--account",
      f.p.account,
      "--scope",
      f.p.scopes[0],
      "--store",
      "json",
      "--output",
      join(f.dir, "eof-commit.json"),
      "--json",
    ],
    {
      env,
      input,
      error,
      signals,
      output: {
        write: (s) => {
          output += s;
        },
      },
      authOptions: {
        configDir: join(f.dir, "profiles"),
        oauthFactory: fakeOAuth().factory,
        store: blocking,
      },
      open: async (url) => {
        const u = new URL(url);
        const cb = new URL(u.searchParams.get("redirect_uri"));
        cb.searchParams.set("state", u.searchParams.get("state"));
        cb.searchParams.set("code", "synthetic-code");
        await fetch(cb).catch(() => {});
        return false;
      },
    },
  );
  assert.equal(ended, true);
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).status, "saved");
  assert.equal((await store.read()).account, f.p.account);
  clean(output);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(input.listenerCount("end"), 0);
  error.destroy();
  input.destroy();
});
