import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { startAuth } from "./auth.js";
import { refreshProfile, profileStatus } from "./service.js";
import { listScopes } from "./scopes.js";
import { AppError, publicError } from "./errors.js";

const reference = z
  .string()
  .min(1)
  .refine((s) => !s.includes("\0"));
const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const opSource = z.strictObject({
  vault: reference,
  item: reference,
  tokenEnv: variable.optional(),
  clientIdField: reference.optional(),
  clientSecretField: reference.optional(),
  projectIdField: reference.optional(),
  type: z.enum(["installed", "web"]).optional(),
});
const clientSource = z.union([
  z.strictObject({ file: reference }),
  z.strictObject({ env: variable }),
  z.strictObject({ op: opSource }),
]);
const store = z.union([
  z.strictObject({
    kind: z.enum(["json", "env"]),
    path: reference,
    prefix: variable.optional(),
  }),
  z.strictObject({
    kind: z.literal("1password"),
    vault: reference,
    item: reference.optional(),
    title: reference.optional(),
    tokenEnv: variable.optional(),
    refreshField: reference.optional(),
  }),
]);
const profile = z.strictObject({
  version: z.literal(1),
  name,
  account: reference,
  clientSource,
  store,
  scopes: z.array(reference),
  redirectUri: reference.optional(),
});
const session = z.strictObject({ id: reference });
const savedProfile = z.strictObject({ profile: name });
const scopeOptions = z.strictObject({
  projectId: reference.optional(),
  cloudTokenEnv: variable.optional(),
  cloudTokenFile: reference.optional(),
  cloudTokenOp: z
    .strictObject({
      vault: reference,
      item: reference,
      field: reference.optional(),
      tokenEnv: variable.optional(),
    })
    .optional(),
  api: reference.optional(),
});
const definitions = [
  [
    "auth_start",
    "Start browser consent using a secret-free profile descriptor.",
    z.strictObject({ profile }),
  ],
  ["auth_status", "Get metadata for an authentication session.", session],
  [
    "auth_save_retry",
    "Retry storage for a verified save-failed session without new consent.",
    session,
  ],
  [
    "auth_cancel",
    "Cancel a session and await any persistence already started.",
    session,
  ],
  [
    "scopes_list",
    "List OAuth scope candidates; API enablement is separate from permission.",
    scopeOptions,
  ],
  [
    "refresh",
    "Refresh a saved profile and return metadata only.",
    savedProfile,
  ],
  [
    "profile_status",
    "Read profile metadata without remote refresh.",
    savedProfile,
  ],
];
const result = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  ...(isError ? { isError: true } : {}),
});
const invalid = () => {
  throw new AppError("INVALID_CONFIG");
};

export function createMcpServer({
  authOptions = {},
  serviceOptions = {},
  scopeOptions: catalogOptions = {},
  services = {},
} = {}) {
  const api = {
    startAuth,
    refreshProfile,
    profileStatus,
    listScopes,
    ...services,
  };
  // Low-level SDK handlers let us replace validation diagnostics with fixed errors.
  const server = new Server(
    { name: "grantloom", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  let active,
    starting,
    closed = false,
    cleanupPromise,
    resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      closed = true;
      await starting?.catch(() => {});
      await active?.cancel();
    })());
  server.onclose = () => {
    cleanup().then(resolveDone, resolveDone);
  };
  server.onerror = () => {};
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map(([name, description, schema]) => ({
      name,
      description,
      inputSchema: z.toJSONSchema(schema),
      annotations: { openWorldHint: true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (closed) invalid();
      const definition = definitions.find(
        ([name]) => name === request.params.name,
      );
      if (!definition) invalid();
      const parsed = definition[2].safeParse(request.params.arguments ?? {});
      if (!parsed.success) invalid();
      const args = parsed.data;
      switch (definition[0]) {
        case "auth_start": {
          if (
            starting ||
            (active &&
              ["pending", "verifying", "saving", "save-failed"].includes(
                active.status().status,
              ))
          )
            invalid();
          starting = api.startAuth(args.profile, authOptions);
          try {
            active = await starting;
          } finally {
            starting = undefined;
          }
          if (closed) await active.cancel();
          return result({ id: active.id, url: active.url, ...active.status() });
        }
        case "auth_status":
        case "auth_save_retry":
        case "auth_cancel": {
          if (!active || active.id !== args.id) invalid();
          const value =
            definition[0] === "auth_status"
              ? active.status()
              : await active[
                  definition[0] === "auth_save_retry" ? "retrySave" : "cancel"
                ]();
          return result(value);
        }
        case "scopes_list":
          return result(await api.listScopes({ ...catalogOptions, ...args }));
        case "refresh":
          return result(await api.refreshProfile(args.profile, serviceOptions));
        case "profile_status":
          return result(await api.profileStatus(args.profile, serviceOptions));
      }
    } catch (error) {
      return result(publicError(error), true);
    }
  });
  return {
    server,
    done,
    close: async () => {
      await cleanup();
      await server.close();
      resolveDone();
    },
  };
}

export async function serveStdio({
  input = process.stdin,
  output = process.stdout,
  signals = process,
  ...options
} = {}) {
  const adapter = createMcpServer(options);
  const transport = new StdioServerTransport(input, output);
  const stop = () => {
    adapter.close().catch(() => {});
  };
  input.once("end", stop);
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  try {
    await adapter.server.connect(transport);
    await adapter.done;
  } finally {
    input.off("end", stop);
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
    await adapter.close();
  }
}
