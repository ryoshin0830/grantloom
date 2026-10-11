import { isDeepStrictEqual } from "node:util";
import { loadProfile, loadClient } from "./config.js";
import { createStore, validateRecord } from "./stores.js";
import { resolveScopes } from "./scopes.js";
import { AppError } from "./errors.js";
import {
  oauthFactory,
  canonicalScopes,
  verifyTokenInfo,
  publicStatus,
} from "./auth.js";

const sameScopes = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
async function storedProfile(name, options) {
  const profile = await loadProfile(name, options);
  const store = createStore(profile.store, options);
  const record = validateRecord(await store.read());
  if (!Number.isFinite(new Date(record.tokens.expiry_date).getTime()))
    throw new AppError("INVALID_RECORD");
  const client = await loadClient(profile.clientSource, options);
  const requested = resolveScopes(profile.scopes);
  if (
    record.account.toLowerCase() !== profile.account.toLowerCase() ||
    record.client.clientId !== client.clientId ||
    !sameScopes(canonicalScopes(record.requestedScopes), requested) ||
    requested.some(
      (scope) => !canonicalScopes(record.grantedScopes).includes(scope),
    )
  )
    throw new AppError("STORE_CONFLICT");
  return { profile, store, record, client, requested };
}
export async function profileStatus(name, options = {}) {
  const { profile, store, record } = await storedProfile(name, options);
  return publicStatus(
    record.tokens.expiry_date > Date.now() ? "saved" : "expired",
    profile,
    record,
    store.reference,
  );
}
export async function refreshProfile(
  name,
  { oauthFactory: factory = oauthFactory, ...options } = {},
) {
  const { profile, store, record, client, requested } = await storedProfile(
    name,
    options,
  );
  let oauth;
  let updated;
  try {
    oauth = factory({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    });
    oauth.setCredentials(record.tokens);
    const { credentials } = await oauth.refreshAccessToken();
    if (!credentials?.access_token) throw new AppError("TOKEN_INVALID");
    const info = await oauth.getTokenInfo(credentials.access_token);
    const granted = verifyTokenInfo(
      info,
      client.clientId,
      profile.account,
      requested,
    );
    if (!sameScopes(granted, canonicalScopes(record.grantedScopes)))
      throw new AppError("STORE_CONFLICT");
    updated = validateRecord({
      ...record,
      client: { clientId: client.clientId, clientSecret: client.clientSecret },
      requestedScopes: requested,
      grantedScopes: granted,
      tokens: {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token || record.tokens.refresh_token,
        expiry_date: info.expiry_date,
      },
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    throw error instanceof AppError ? error : new AppError("OAUTH_FAILED");
  } finally {
    oauth?.setCredentials({});
  }
  await store.write(updated);
  if (!isDeepStrictEqual(await store.read(), updated))
    throw new AppError("STORE_MISMATCH");
  return publicStatus("saved", profile, updated, store.reference);
}
export async function profileEnvironment(name, options = {}) {
  const { profile, record } = await storedProfile(name, options);
  if (record.tokens.expiry_date <= Date.now())
    throw new AppError("TOKEN_EXPIRED");
  const prefix = profile.store.prefix ?? "GRANTLOOM";
  return {
    [`${prefix}_CLIENT_ID`]: record.client.clientId,
    [`${prefix}_CLIENT_SECRET`]: record.client.clientSecret,
    [`${prefix}_ACCESS_TOKEN`]: record.tokens.access_token,
    [`${prefix}_REFRESH_TOKEN`]: record.tokens.refresh_token,
    [`${prefix}_ACCESS_TOKEN_EXPIRES_AT`]: new Date(
      record.tokens.expiry_date,
    ).toISOString(),
  };
}
