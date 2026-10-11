import { AppError } from "./errors.js";
import { readPrivate } from "./files.js";
import { runOp, callOp } from "./op.js";
const auth = "https://www.googleapis.com/auth/";
const catalog = [
  ["gmail.full", "https://mail.google.com/", "Full Gmail access", "gmail"],
  ["gmail.readonly", auth + "gmail.readonly", "Read Gmail messages", "gmail"],
  [
    "gmail.modify",
    auth + "gmail.modify",
    "Read and modify Gmail messages",
    "gmail",
  ],
  [
    "gmail.compose",
    auth + "gmail.compose",
    "Compose and send Gmail messages",
    "gmail",
  ],
  ["drive.full", auth + "drive", "Full Drive access", "drive"],
  ["drive.readonly", auth + "drive.readonly", "Read Drive files", "drive"],
  ["sheets", auth + "spreadsheets", "Read and edit spreadsheets", "sheets"],
  [
    "sheets.readonly",
    auth + "spreadsheets.readonly",
    "Read spreadsheets",
    "sheets",
  ],
  ["calendar", auth + "calendar", "Read and edit calendars", "calendar"],
  [
    "calendar.readonly",
    auth + "calendar.readonly",
    "Read calendars",
    "calendar",
  ],
];
const aliases = new Map(catalog.map(([alias, uri]) => [alias, uri]));
const emailAliases = new Set([
  "email",
  "userinfo.email",
  auth + "userinfo.email",
]);
function normalize(scope) {
  if (emailAliases.has(scope)) return "email";
  if (scope === "openid" || scope === "profile") return scope;
  if (aliases.has(scope)) return aliases.get(scope);
  if (
    typeof scope === "string" &&
    (scope === "https://mail.google.com/" ||
      (/^https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(
        scope,
      ) &&
        !scope.split("/").includes("..")))
  )
    return scope;
  throw new AppError("SCOPES_INVALID");
}
export function resolveScopes(input) {
  if (!Array.isArray(input)) throw new AppError("SCOPES_INVALID");
  return [...new Set([...input.map(normalize), "openid", "email"])];
}
async function requestJson(fetch, url, headers, errorCode) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) throw new AppError(errorCode);
        return await response.json();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AppError(errorCode));
        }, 10000);
      }),
    ]);
  } catch {
    throw new AppError(errorCode);
  } finally {
    clearTimeout(timer);
  }
}
async function cloudToken({
  cloudTokenEnv,
  cloudTokenFile,
  cloudTokenOp,
  env,
  op,
}) {
  if (
    [cloudTokenEnv, cloudTokenFile, cloudTokenOp].filter((v) => v !== undefined)
      .length > 1
  )
    throw new AppError("INVALID_CONFIG");
  let value;
  if (cloudTokenEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cloudTokenEnv))
      throw new AppError("INVALID_CONFIG");
    value = env[cloudTokenEnv];
  } else if (cloudTokenFile) value = (await readPrivate(cloudTokenFile)).trim();
  else if (cloudTokenOp) {
    const o = cloudTokenOp;
    if (
      !o ||
      Object.keys(o).some(
        (k) => !["vault", "item", "field", "tokenEnv"].includes(k),
      ) ||
      typeof o.vault !== "string" ||
      !o.vault ||
      typeof o.item !== "string" ||
      !o.item ||
      (o.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.tokenEnv))
    )
      throw new AppError("INVALID_CONFIG");
    const item = await callOp(
      op,
      [
        "item",
        "get",
        o.item,
        "--vault",
        o.vault,
        "--format",
        "json",
        "--reveal",
      ],
      { env, tokenEnv: o.tokenEnv },
    );
    value = item.fields?.find(
      (f) =>
        f.label === (o.field ?? "access_token") ||
        f.id === (o.field ?? "access_token"),
    )?.value;
  }
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value))
    throw new AppError("CLOUD_FAILED");
  return value;
}
export async function listScopes({
  projectId,
  cloudTokenEnv,
  cloudTokenFile,
  cloudTokenOp,
  api,
  fetch = globalThis.fetch,
  env = process.env,
  op = runOp,
} = {}) {
  if (
    projectId !== undefined &&
    (typeof projectId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(projectId))
  )
    throw new AppError("INVALID_CONFIG");
  if (
    api !== undefined &&
    (typeof api !== "string" || !/^[a-z][a-z0-9]*$/.test(api))
  )
    throw new AppError("INVALID_CONFIG");
  let enabledStatus = "unverified";
  let enabledApis = [];
  if (
    projectId &&
    [cloudTokenEnv, cloudTokenFile, cloudTokenOp].some((v) => v !== undefined)
  ) {
    try {
      const token = await cloudToken({
        cloudTokenEnv,
        cloudTokenFile,
        cloudTokenOp,
        env,
        op,
      });
      const seen = new Set();
      let page;
      do {
        const url = new URL(
          `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services`,
        );
        url.searchParams.set("filter", "state:ENABLED");
        if (page) url.searchParams.set("pageToken", page);
        const data = await requestJson(
          fetch,
          url.toString(),
          { Authorization: `Bearer ${token}` },
          "CLOUD_FAILED",
        );
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          (data.services !== undefined && !Array.isArray(data.services)) ||
          (data.nextPageToken !== undefined &&
            typeof data.nextPageToken !== "string")
        )
          throw new AppError("CLOUD_FAILED");
        for (const service of data.services ?? []) {
          const name = service?.config?.name;
          if (
            typeof name !== "string" ||
            !/^[a-z0-9.-]+\.googleapis\.com$/.test(name) ||
            (service.state !== undefined && service.state !== "ENABLED")
          )
            throw new AppError("CLOUD_FAILED");
          enabledApis.push(name);
        }
        page = data.nextPageToken;
        if (page) {
          if (seen.has(page) || seen.size >= 100)
            throw new AppError("CLOUD_FAILED");
          seen.add(page);
        }
      } while (page);
      enabledStatus = "verified";
      enabledApis = [...new Set(enabledApis)];
    } catch {
      enabledStatus = "unavailable";
      enabledApis = [];
    }
  }
  const entries = catalog.map(([, uri, label, id]) => ({
    uri,
    label,
    api: `${id}.googleapis.com`,
  }));
  if (api) {
    const version = { drive: "v3", sheets: "v4", calendar: "v3" }[api] ?? "v1";
    const data = await requestJson(
      fetch,
      `https://www.googleapis.com/discovery/v1/apis/${api}/${version}/rest`,
      {},
      "DISCOVERY_FAILED",
    );
    const scopes = data?.auth?.oauth2?.scopes;
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes))
      throw new AppError("DISCOVERY_FAILED");
    for (const [scope, details] of Object.entries(scopes)) {
      let uri;
      try {
        uri = normalize(scope);
        if (!details || typeof details.description !== "string")
          throw new Error();
      } catch {
        throw new AppError("DISCOVERY_FAILED");
      }
      if (!entries.some((c) => c.uri === uri))
        entries.push({
          uri,
          label: details.description,
          api: `${api}.googleapis.com`,
        });
    }
  }
  return {
    enabledStatus,
    enabledApis,
    candidates: entries.map((entry) => ({
      ...entry,
      enabledStatus:
        enabledStatus === "verified"
          ? enabledApis.includes(entry.api)
            ? "enabled"
            : "disabled"
          : "unverified",
    })),
  };
}
