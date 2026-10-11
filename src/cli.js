import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { startAuth } from "./auth.js";
import {
  profileStatus,
  refreshProfile,
  profileEnvironment,
} from "./service.js";
import { loadClient, validateProfile } from "./config.js";
import { resolveScopes, listScopes } from "./scopes.js";
import { AppError, publicError } from "./errors.js";

const clientFlags = [
  "client-json",
  "client-env",
  "client-op-item",
  "op-vault",
  "op-token-env",
  "client-id-field",
  "client-secret-field",
  "client-project-field",
  "client-type",
];
const authFlags = [
  ...clientFlags,
  "store-vault",
  "account",
  "scope",
  "store",
  "output",
  "prefix",
  "item",
  "title",
  "refresh-field",
  "profile",
  "redirect-uri",
  "no-open",
];
const scopeFlags = [
  "project-id",
  "cloud-token-env",
  "cloud-token-file",
  "cloud-token-op",
  "op-token-env",
  "api",
];
const options = Object.fromEntries(
  [...new Set([...authFlags, ...scopeFlags])].map((k) => [
    k,
    k === "scope"
      ? { type: "string", multiple: true }
      : { type: k === "no-open" ? "boolean" : "string" },
  ]),
);
for (const k of ["json", "help", "version"]) options[k] = { type: "boolean" };
const invalid = () => {
  throw new AppError("INVALID_CONFIG");
};
const optional = (obj, key, value) => {
  if (value !== undefined) obj[key] = value;
};
export const HELP = `grantloom 0.1.0 — bring-your-own-client Google OAuth
Usage: grantloom [auth|scopes|refresh|status|exec|mcp] [options]
  auth       Wait for browser consent, verification and credential storage
  scopes     List scope candidates and optional enabled API metadata
  refresh    Refresh a saved profile
  status     Show profile metadata (no remote refresh)
  exec       Inject a profile into a subprocess: --profile NAME -- command args
  mcp        Run the metadata-only stdio MCP server
Client: --client-json PATH | --client-env VAR | --client-op-item ID
        --op-vault VAULT --op-token-env VAR
        --client-id-field FIELD --client-secret-field FIELD
        --client-project-field FIELD --client-type installed|web
Auth:   --account EMAIL --scope ALIAS_OR_URI (repeatable or comma-separated)
        --store json|env|1password --output PATH --prefix PREFIX
        --store-vault VAULT --item ID | --title NAME --refresh-field FIELD
        --profile NAME --redirect-uri URI --no-open
Scopes: --project-id ID --cloud-token-env VAR | --cloud-token-file PATH
        | --cloud-token-op op://VAULT/ITEM/FIELD --api API
Output: --json (metadata only) --help --version
Secrets are accepted only through files, named environment variables or op.
`;
function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "auth";
  const args = command === argv[0] ? argv.slice(1) : argv;
  const separator = args.indexOf("--");
  const { values: v } = parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    options,
    strict: true,
    allowPositionals: false,
  });
  if (!["auth", "scopes", "status", "refresh", "exec", "mcp"].includes(command))
    invalid();
  const allowed =
    command === "auth"
      ? [...authFlags, ...scopeFlags]
      : command === "scopes"
        ? scopeFlags
        : ["status", "refresh", "exec"].includes(command)
          ? ["profile"]
          : [];
  if (
    Object.keys(v).some(
      (k) => !["json", "help", "version", ...allowed].includes(k),
    )
  )
    invalid();
  for (const flag of [
    "client-env",
    "op-token-env",
    "cloud-token-env",
    "prefix",
  ])
    if (v[flag] !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v[flag]))
      invalid();
  if (separator >= 0 && command !== "exec") invalid();
  const child = separator >= 0 ? args.slice(separator + 1) : [];
  if (command === "exec" && !v.help && !child.length) invalid();
  return { command, v, child };
}
const tokenEnv = (v, env) =>
  v["op-token-env"] ??
  (env.OP_SERVICE_ACCOUNT_TOKEN ? "OP_SERVICE_ACCOUNT_TOKEN" : undefined);
async function descriptor(v, ask, env, catalog) {
  const choices = ["client-json", "client-env", "client-op-item"].filter(
    (k) => v[k] !== undefined,
  );
  if (choices.length > 1) invalid();
  const kind =
    choices[0]?.replace("client-", "") ??
    (await ask("Client source (file/env/1password): "));
  let source;
  if (kind === "file" || kind === "json")
    source = { file: v["client-json"] ?? (await ask("Client JSON path: ")) };
  else if (kind === "env")
    source = { env: v["client-env"] ?? (await ask("Client JSON variable: ")) };
  else if (kind === "op-item" || kind === "1password") {
    source = {
      op: {
        vault: v["op-vault"] ?? (await ask("Client vault: ")),
        item: v["client-op-item"] ?? (await ask("Client item ID: ")),
      },
    };
    for (const [flag, key] of [
      ["client-id-field", "clientIdField"],
      ["client-secret-field", "clientSecretField"],
      ["client-project-field", "projectIdField"],
      ["client-type", "type"],
    ])
      optional(source.op, key, v[flag]);
    optional(source.op, "tokenEnv", tokenEnv(v, env));
  } else invalid();
  if (
    !source.op &&
    [
      "client-id-field",
      "client-secret-field",
      "client-project-field",
      "client-type",
    ].some((k) => v[k] !== undefined)
  )
    invalid();
  const account = v.account ?? (await ask("Google account email: "));
  await catalog(source);
  const scopes = resolveScopes(
    (
      v.scope ?? [
        await ask(
          "Scopes (aliases/URIs, comma separated; blank = identity only): ",
        ),
      ]
    ).flatMap((s) =>
      s
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
  const store = {
    kind: v.store ?? (await ask("Store kind (json/env/1password): ")),
  };
  if (store.kind === "1password") {
    store.vault =
      v["store-vault"] ?? v["op-vault"] ?? (await ask("Destination vault: "));
    if (v.item && v.title) invalid();
    if (v.item) store.item = v.item;
    else store.title = v.title ?? (await ask("New destination title: "));
    optional(store, "tokenEnv", tokenEnv(v, env));
    optional(store, "refreshField", v["refresh-field"]);
    if (v.output || v.prefix) invalid();
  } else {
    if (
      ["store-vault", "item", "title", "refresh-field"].some(
        (k) => v[k] !== undefined,
      )
    )
      invalid();
    store.path = v.output ?? (await ask("Destination path: "));
    optional(store, "prefix", v.prefix);
  }
  const name = v.profile ?? (await ask("Profile name: "));
  return validateProfile({
    version: 1,
    name,
    account,
    clientSource: source,
    store,
    scopes,
    ...(v["redirect-uri"] ? { redirectUri: v["redirect-uri"] } : {}),
  });
}
function cloudOptions(v, env) {
  const o = { env };
  for (const [flag, key] of [
    ["project-id", "projectId"],
    ["cloud-token-env", "cloudTokenEnv"],
    ["cloud-token-file", "cloudTokenFile"],
    ["api", "api"],
  ])
    optional(o, key, v[flag]);
  if (v["cloud-token-op"]) {
    const ref = /^op:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(v["cloud-token-op"]);
    if (!ref) invalid();
    try {
      o.cloudTokenOp = {
        vault: decodeURIComponent(ref[1]),
        item: decodeURIComponent(ref[2]),
        field: decodeURIComponent(ref[3]),
      };
    } catch {
      invalid();
    }
    optional(o.cloudTokenOp, "tokenEnv", tokenEnv(v, env));
  }
  if (
    ["cloud-token-env", "cloud-token-file", "cloud-token-op"].filter(
      (k) => v[k] !== undefined,
    ).length > 1
  )
    invalid();
  return o;
}
export function openBrowser(url, { platform = process.platform } = {}) {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false });
    child.unref();
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
function execute(args, env, signals) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      env,
      stdio: "inherit",
      shell: false,
    });
    const interrupt = () => child.kill("SIGINT");
    signals.on("SIGINT", interrupt);
    child.on("error", () => {
      signals.off("SIGINT", interrupt);
      reject(new AppError("INTERNAL_ERROR"));
    });
    child.on("close", (code, signal) => {
      signals.off("SIGINT", interrupt);
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}
export async function runCLI(
  argv,
  {
    input = process.stdin,
    output = process.stdout,
    error = process.stderr,
    env = process.env,
    signals = process,
    authOptions = {},
    open = openBrowser,
    services = {},
  } = {},
) {
  const api = {
    loadClient,
    startAuth,
    profileStatus,
    refreshProfile,
    profileEnvironment,
    listScopes,
    ...services,
  };
  let session,
    rl,
    cancelled = false,
    cancelPromise;
  const abort = new AbortController();
  const emit = (value) => output.write(JSON.stringify(value) + "\n");
  const interrupt = () => {
    cancelled = true;
    abort.abort();
    if (session) cancelPromise = session.cancel();
  };
  const ask = async (question) => {
    if (!input.isTTY) invalid();
    rl ??= createInterface({ input, output: error });
    return (await rl.question(question, { signal: abort.signal })).trim();
  };
  signals.on("SIGINT", interrupt);
  try {
    let parsed;
    try {
      parsed = parse(argv);
    } catch {
      invalid();
    }
    const { command, v, child } = parsed;
    if (v.help) {
      output.write(HELP);
      return 0;
    }
    if (v.version) {
      output.write("0.1.0\n");
      return 0;
    }
    if (command === "mcp") {
      signals.off("SIGINT", interrupt);
      const { serveStdio } = await import("./mcp.js");
      await serveStdio();
      return 0;
    }
    if (command === "auth") {
      const profile = await descriptor(v, ask, env, async (source) => {
        const client = await api.loadClient(source, { env, ...authOptions });
        const catalog = await api.listScopes({
          ...cloudOptions(v, env),
          projectId: v["project-id"] ?? client.projectId,
          ...(authOptions.op ? { op: authOptions.op } : {}),
        });
        error.write(JSON.stringify(catalog) + "\n");
      });
      const storage =
        profile.store.kind === "1password"
          ? {
              kind: "1password",
              vault: profile.store.vault,
              ...(profile.store.item
                ? { item: profile.store.item }
                : { title: profile.store.title }),
            }
          : { kind: profile.store.kind, path: profile.store.path };
      error.write(
        JSON.stringify({
          account: profile.account,
          requestedScopes: profile.scopes,
          storage,
        }) + "\n",
      );
      if (cancelled) return 130;
      session = await api.startAuth(profile, { env, ...authOptions });
      error.write(`Open this Google consent URL:\n${session.url}\n`);
      if (cancelled) await session.cancel();
      else if (!v["no-open"]) {
        // An advisory browser opener must not hold up cancellation.
        Promise.resolve()
          .then(() => open(session.url))
          .catch(() => false);
      }
      let status = await session.done;
      while (status.status === "save-failed" && !cancelled && input.isTTY) {
        const answer = await ask(
          "Save failed. Type retry to retry storage, or cancel: ",
        );
        if (answer !== "retry") {
          status = await session.cancel();
          break;
        }
        status = await session.retrySave();
      }
      if (cancelPromise) status = await cancelPromise;
      emit(status);
      return status.status === "saved"
        ? 0
        : status.status === "cancelled"
          ? 130
          : 1;
    }
    if (command === "scopes") {
      emit(await api.listScopes(cloudOptions(v, env)));
      return 0;
    }
    const name = v.profile ?? (await ask("Profile name: "));
    if (command === "exec")
      return await execute(
        child,
        { ...env, ...(await api.profileEnvironment(name, { env })) },
        signals,
      );
    emit(
      await api[command === "refresh" ? "refreshProfile" : "profileStatus"](
        name,
        { env },
      ),
    );
    return 0;
  } catch (e) {
    if (cancelled) {
      emit(
        session
          ? await session.cancel()
          : {
              code: "AUTH_CANCELLED",
              message: "Authentication was cancelled.",
            },
      );
      return 130;
    }
    const value = publicError(e);
    emit(value);
    return ["INVALID_CONFIG", "INVALID_CLIENT", "SCOPES_INVALID"].includes(
      value.code,
    )
      ? 2
      : 1;
  } finally {
    rl?.close();
    signals.off("SIGINT", interrupt);
    if (
      session &&
      !["saved", "failed", "expired", "cancelled"].includes(
        session.status().status,
      )
    )
      await session.cancel();
  }
}
