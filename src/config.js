import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { AppError } from "./errors.js";
import { runOp, callOp } from "./op.js";
import { atomicWrite, readPrivate } from "./files.js";
const validVariable = (value) =>
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const nonempty = (value) =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");
function keys(value, allowed) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}
export function validateClientSource(source) {
  if (
    !keys(source, ["file", "env", "op"]) ||
    Object.keys(source).length !== 1 ||
    Object.values(source)[0] === undefined
  )
    throw new AppError("INVALID_CONFIG");
  if (source.file !== undefined && !nonempty(source.file))
    throw new AppError("INVALID_CONFIG");
  if (source.env !== undefined && !validVariable(source.env))
    throw new AppError("INVALID_CONFIG");
  if (source.op !== undefined) {
    const o = source.op;
    if (
      !keys(o, [
        "vault",
        "item",
        "tokenEnv",
        "clientIdField",
        "clientSecretField",
        "projectIdField",
        "type",
      ]) ||
      !nonempty(o.vault) ||
      !nonempty(o.item) ||
      (o.tokenEnv !== undefined && !validVariable(o.tokenEnv)) ||
      (o.type !== undefined && !["installed", "web"].includes(o.type)) ||
      ["clientIdField", "clientSecretField", "projectIdField"].some(
        (k) => o[k] !== undefined && !nonempty(o[k]),
      )
    )
      throw new AppError("INVALID_CONFIG");
  }
  return source;
}
export function validateStoreOptions(o) {
  if (
    !keys(o, [
      "kind",
      "path",
      "prefix",
      "vault",
      "item",
      "title",
      "tokenEnv",
      "refreshField",
    ]) ||
    !["json", "env", "1password"].includes(o.kind)
  )
    throw new AppError("INVALID_CONFIG");
  if (o.kind === "1password") {
    if (
      !nonempty(o.vault) ||
      (!nonempty(o.item) && !nonempty(o.title)) ||
      o.path !== undefined ||
      o.prefix !== undefined
    )
      throw new AppError("INVALID_CONFIG");
  } else if (
    !nonempty(o.path) ||
    ["vault", "item", "title", "tokenEnv", "refreshField"].some(
      (k) => o[k] !== undefined,
    )
  )
    throw new AppError("INVALID_CONFIG");
  if (
    (o.prefix !== undefined && !validVariable(o.prefix)) ||
    (o.tokenEnv !== undefined && !validVariable(o.tokenEnv)) ||
    (o.refreshField !== undefined &&
      (!nonempty(o.refreshField) ||
        [
          "version",
          "account",
          "client_id",
          "client_secret",
          "requested_scopes",
          "granted_scopes",
          "access_token",
          "expiry_date",
          "obtained_at",
          "verified_at",
        ].includes(o.refreshField)))
  )
    throw new AppError("INVALID_CONFIG");
  return o;
}
export async function loadClient(
  source,
  { env = process.env, op = runOp } = {},
) {
  validateClientSource(source);
  let value;
  try {
    if (source.op) {
      const o = source.op;
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
      const get = (name) =>
        item.fields?.find((f) => f.label === name || f.id === name)?.value;
      value = {
        [o.type ?? "installed"]: {
          client_id: get(o.clientIdField ?? "client_id"),
          client_secret: get(o.clientSecretField ?? "client_secret"),
          project_id: get(o.projectIdField ?? "project_id"),
          redirect_uris: [],
        },
      };
    } else
      value = JSON.parse(
        source.file ? await readFile(source.file, "utf8") : env[source.env],
      );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("INVALID_CLIENT");
  }
  const type =
    value && Object.hasOwn(value, "installed") && !Object.hasOwn(value, "web")
      ? "installed"
      : value &&
          Object.hasOwn(value, "web") &&
          !Object.hasOwn(value, "installed")
        ? "web"
        : null;
  const c = value?.[type];
  if (
    !type ||
    !c ||
    !nonempty(c.client_id) ||
    !nonempty(c.client_secret) ||
    (c.project_id !== undefined && !nonempty(c.project_id)) ||
    (c.redirect_uris !== undefined &&
      (!Array.isArray(c.redirect_uris) ||
        c.redirect_uris.some((uri) => !nonempty(uri))))
  )
    throw new AppError("INVALID_CLIENT");
  return {
    type,
    clientId: c.client_id,
    clientSecret: c.client_secret,
    ...(c.project_id ? { projectId: c.project_id } : {}),
    redirectUris: c.redirect_uris ?? [],
  };
}
function validateName(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
    throw new AppError("INVALID_CONFIG");
}
export function validateProfile(profile) {
  if (
    !keys(profile, [
      "version",
      "name",
      "account",
      "clientSource",
      "store",
      "scopes",
      "redirectUri",
    ]) ||
    profile.version !== 1 ||
    !nonempty(profile.account) ||
    !Array.isArray(profile.scopes) ||
    profile.scopes.some((s) => !nonempty(s)) ||
    (profile.redirectUri !== undefined && !nonempty(profile.redirectUri))
  )
    throw new AppError("INVALID_CONFIG");
  validateName(profile.name);
  validateClientSource(profile.clientSource);
  validateStoreOptions(profile.store);
  return profile;
}
const profilePath = (name, configDir) =>
  join(
    configDir ??
      process.env.GRANTLOOM_CONFIG_DIR ??
      join(homedir(), ".config", "grantloom"),
    `${name}.json`,
  );
// Windows profiles contain references only; OS directory permissions protect metadata.
const profileFileOptions = () =>
  process.platform === "win32" ? { private: false } : {};
// Resolve existing ancestors too: macOS permits /var and /tmp system aliases.
async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw new AppError("STORE_UNSAFE");
    const parent = dirname(path);
    if (parent === path) throw new AppError("STORE_UNSAFE");
    return join(await canonicalPath(parent), basename(path));
  }
}
// Freeze persistent paths and reject destructive destinations before consent or replacement.
export async function prepareProfile(profile, { configDir } = {}) {
  validateProfile(profile);
  profile = structuredClone(profile);
  const path = resolve(profilePath(profile.name, configDir));
  configDir = dirname(path);
  if (profile.clientSource.file)
    profile.clientSource.file = resolve(profile.clientSource.file);
  if (profile.store.path) profile.store.path = resolve(profile.store.path);
  const destination = await canonicalPath(path);
  const comparable = (path) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  const references = [profile.clientSource.file, profile.store.path].filter(Boolean);
  for (const reference of references)
    if (comparable(await canonicalPath(reference)) === comparable(destination))
      throw new AppError("INVALID_CONFIG");
  try {
    await loadProfile(profile.name, { configDir });
  } catch (error) {
    if (error.code !== "STORE_NOT_FOUND") throw error;
  }
  return { profile, configDir };
}
export async function saveProfile(profile, { configDir } = {}) {
  ({ profile, configDir } = await prepareProfile(profile, { configDir }));
  const path = profilePath(profile.name, configDir);
  const text = JSON.stringify(profile, null, 2) + "\n";
  const options = profileFileOptions();
  await atomicWrite(path, text, options);
  if (
    process.platform === "win32" &&
    (await readPrivate(path, options)) !== text
  )
    throw new AppError("STORE_MISMATCH");
}
export async function loadProfile(name, { configDir } = {}) {
  validateName(name);
  let profile;
  try {
    profile = JSON.parse(
      await readPrivate(profilePath(name, configDir), profileFileOptions()),
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("INVALID_CONFIG");
  }
  validateProfile(profile);
  if (profile.name !== name) throw new AppError("INVALID_CONFIG");
  return profile;
}
