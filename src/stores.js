import { isDeepStrictEqual } from "node:util";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";
import { validateStoreOptions } from "./config.js";
import {
  prepareFile,
  readPrivate,
  atomicWrite,
  withFileLock,
} from "./files.js";
import { runOp, callOp } from "./op.js";
const text = (value) =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");
const keys = (o, list) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).length === list.length &&
  list.every((k) => Object.hasOwn(o, k));
export function validateRecord(r) {
  if (
    !keys(r, [
      "version",
      "account",
      "client",
      "requestedScopes",
      "grantedScopes",
      "tokens",
      "obtainedAt",
      "verifiedAt",
    ]) ||
    r.version !== 1 ||
    !text(r.account) ||
    !keys(r.client, ["clientId", "clientSecret"]) ||
    !text(r.client.clientId) ||
    !text(r.client.clientSecret) ||
    !keys(r.tokens, ["access_token", "refresh_token", "expiry_date"]) ||
    !text(r.tokens.access_token) ||
    !text(r.tokens.refresh_token) ||
    !Number.isFinite(r.tokens.expiry_date) ||
    r.tokens.expiry_date <= 0 ||
    !["obtainedAt", "verifiedAt"].every(
      (k) => text(r[k]) && Number.isFinite(Date.parse(r[k])),
    ) ||
    !["requestedScopes", "grantedScopes"].every(
      (k) => Array.isArray(r[k]) && r[k].length > 0 && r[k].every(text),
    )
  )
    throw new AppError("INVALID_RECORD");
  return r;
}
function compatible(before, after) {
  if (
    before.account.toLowerCase() !== after.account.toLowerCase() ||
    before.client.clientId !== after.client.clientId ||
    ["requestedScopes", "grantedScopes"].some(
      (k) =>
        !isDeepStrictEqual(
          [...new Set(before[k])].sort(),
          [...new Set(after[k])].sort(),
        ),
    )
  )
    throw new AppError("STORE_CONFLICT");
}
const fields = [
  "version",
  "account",
  "client_id",
  "client_secret",
  "requested_scopes",
  "granted_scopes",
  "access_token",
  "refresh_token",
  "expiry_date",
  "obtained_at",
  "verified_at",
];
function recordFields(r) {
  return {
    version: String(r.version),
    account: r.account,
    client_id: r.client.clientId,
    client_secret: r.client.clientSecret,
    requested_scopes: JSON.stringify(r.requestedScopes),
    granted_scopes: JSON.stringify(r.grantedScopes),
    access_token: r.tokens.access_token,
    refresh_token: r.tokens.refresh_token,
    expiry_date: String(r.tokens.expiry_date),
    obtained_at: r.obtainedAt,
    verified_at: r.verifiedAt,
  };
}
function fromFields(f) {
  try {
    return validateRecord({
      version: Number(f.version),
      account: f.account,
      client: { clientId: f.client_id, clientSecret: f.client_secret },
      requestedScopes: JSON.parse(f.requested_scopes),
      grantedScopes: JSON.parse(f.granted_scopes),
      tokens: {
        access_token: f.access_token,
        refresh_token: f.refresh_token,
        expiry_date: Number(f.expiry_date),
      },
      obtainedAt: f.obtained_at,
      verifiedAt: f.verified_at,
    });
  } catch {
    throw new AppError("INVALID_RECORD");
  }
}
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
function encodeEnv(r, prefix) {
  return Object.entries(recordFields(r))
    .map(
      ([key, value]) =>
        `export ${prefix}_${key.toUpperCase()}=${quote(value)}\n`,
    )
    .join("");
}
function decodeEnv(source, prefix) {
  const f = {};
  const expression = /export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'"'"')*)'\n/gy;
  let position = 0;
  while (position < source.length) {
    expression.lastIndex = position;
    const match = expression.exec(source);
    if (!match || !match[1].startsWith(`${prefix}_`))
      throw new AppError("INVALID_RECORD");
    const name = match[1].slice(prefix.length + 1).toLowerCase();
    if (!fields.includes(name) || Object.hasOwn(f, name))
      throw new AppError("INVALID_RECORD");
    f[name] = match[2].replaceAll(`'"'"'`, "'");
    position = expression.lastIndex;
  }
  return fromFields(f);
}
export function createStore(options, { env = process.env, op = runOp } = {}) {
  validateStoreOptions(options);
  const o = { ...options };
  if (o.kind !== "1password") {
    const reference = { kind: o.kind, path: o.path };
    const prefix = o.prefix ?? "GRANTLOOM";
    const read = async () => {
      try {
        const source = await readPrivate(o.path);
        return o.kind === "json"
          ? validateRecord(JSON.parse(source))
          : decodeEnv(source, prefix);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError("INVALID_RECORD");
      }
    };
    return {
      reference,
      async preflight() {
        await prepareFile(o.path);
        try {
          await access(dirname(o.path), constants.W_OK);
        } catch {
          throw new AppError("STORE_FAILED");
        }
        try {
          await read();
        } catch (e) {
          if (e.code !== "STORE_NOT_FOUND") throw e;
        }
      },
      read,
      async write(record) {
        validateRecord(record);
        return withFileLock(o.path, async () => {
          try {
            compatible(await read(), record);
          } catch (e) {
            if (e.code !== "STORE_NOT_FOUND") throw e;
          }
          await atomicWrite(
            o.path,
            o.kind === "json"
              ? JSON.stringify(record, null, 2) + "\n"
              : encodeEnv(record, prefix),
          );
          if (!isDeepStrictEqual(await read(), record))
            throw new AppError("STORE_MISMATCH");
          return reference;
        });
      },
    };
  }
  let itemId;
  let resolved = false;
  const opts = { env, tokenEnv: o.tokenEnv };
  const run = (args) => callOp(op, args, opts);
  async function resolveItem() {
    if (resolved && itemId) return itemId;
    if (o.item) {
      const item = await run([
        "item",
        "get",
        o.item,
        "--vault",
        o.vault,
        "--format",
        "json",
        "--reveal",
      ]);
      if (!text(item?.id)) throw new AppError("OP_FAILED");
      itemId = item.id;
    } else {
      const items = await run([
        "item",
        "list",
        "--vault",
        o.vault,
        "--format",
        "json",
      ]);
      if (!Array.isArray(items)) throw new AppError("OP_FAILED");
      const matches = items.filter((item) => item.title === o.title);
      if (matches.length > 1) throw new AppError("STORE_AMBIGUOUS");
      itemId = matches[0]?.id;
    }
    resolved = true;
    return itemId;
  }
  async function getItem() {
    if (!(await resolveItem())) throw new AppError("STORE_NOT_FOUND");
    const item = await run([
      "item",
      "get",
      itemId,
      "--vault",
      o.vault,
      "--format",
      "json",
      "--reveal",
    ]);
    if (item.id !== itemId || !Array.isArray(item.fields))
      throw new AppError("OP_FAILED");
    return item;
  }
  function decodeItem(item) {
    const result = {};
    for (const name of fields) {
      const matches = item.fields.filter(
        (f) =>
          f.label ===
          (name === "refresh_token" ? (o.refreshField ?? name) : name),
      );
      if (matches.length !== 1) throw new AppError("INVALID_RECORD");
      result[name] = matches[0].value;
    }
    return fromFields(result);
  }
  const reference = () => ({
    kind: "1password",
    vault: o.vault,
    ...(itemId
      ? { item: itemId }
      : o.item
        ? { item: o.item }
        : { title: o.title }),
  });
  return {
    get reference() {
      return reference();
    },
    async preflight() {
      await run(["vault", "get", o.vault, "--format", "json"]);
      if (await resolveItem()) decodeItem(await getItem());
    },
    async read() {
      return decodeItem(await getItem());
    },
    async write(record) {
      validateRecord(record);
      let existing;
      try {
        existing = await getItem();
        compatible(decodeItem(existing), record);
      } catch (e) {
        if (e.code !== "STORE_NOT_FOUND") throw e;
      }
      const values = recordFields(record);
      const managedLabels = fields.map((name) =>
        name === "refresh_token" ? (o.refreshField ?? name) : name,
      );
      const retained = (existing?.fields ?? []).filter(
        (f) => !managedLabels.includes(f.label),
      );
      const updated = Object.entries(values).map(([name, value]) => {
        const label =
          name === "refresh_token" ? (o.refreshField ?? name) : name;
        const previous = existing?.fields.find((f) => f.label === label);
        return {
          ...previous,
          ...(!previous ? { id: name } : {}),
          label,
          type: ["client_secret", "access_token", "refresh_token"].includes(
            name,
          )
            ? "CONCEALED"
            : "STRING",
          value,
        };
      });
      const input = {
        ...existing,
        title: existing?.title ?? o.title,
        category: existing?.category ?? "LOGIN",
        fields: [...retained, ...updated],
      };
      const args = itemId
        ? ["item", "edit", itemId, "--vault", o.vault, "--format", "json"]
        : ["item", "create", "-", "--vault", o.vault, "--format", "json"];
      const result = await callOp(op, args, { ...opts, input });
      if (!text(result?.id) || (itemId && result.id !== itemId))
        throw new AppError("STORE_MISMATCH");
      itemId = result.id;
      resolved = true;
      if (!isDeepStrictEqual(decodeItem(await getItem()), record))
        throw new AppError("STORE_MISMATCH");
      return reference();
    },
  };
}
