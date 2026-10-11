import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OAuth2Client } from "google-auth-library";
import { loadClient, prepareProfile, saveProfile } from "./config.js";
import { createStore, validateRecord } from "./stores.js";
import { resolveScopes } from "./scopes.js";
import { AppError, publicError } from "./errors.js";

export const oauthFactory = (options) =>
  new OAuth2Client({
    ...options,
    transporterOptions: { timeout: 10000, retry: false },
  });
// Canonicalize without silently adding the identity scopes to Google's response.
export function canonicalScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length)
    throw new AppError("SCOPES_MISSING");
  return [...new Set(scopes.map((scope) => resolveScopes([scope])[0]))];
}
export function verifyTokenInfo(
  info,
  clientId,
  account,
  requestedScopes,
  now = Date.now,
) {
  if (
    !info ||
    info.aud !== clientId ||
    !Number.isFinite(info.expiry_date) ||
    !Number.isFinite(new Date(info.expiry_date).getTime()) ||
    info.expiry_date <= now()
  )
    throw new AppError("TOKEN_INVALID");
  if (
    ![true, "true"].includes(info.email_verified) ||
    typeof info.email !== "string" ||
    info.email.toLowerCase() !== account.toLowerCase()
  )
    throw new AppError("ACCOUNT_MISMATCH");
  const scopes = canonicalScopes(info.scopes);
  if (requestedScopes.some((scope) => !scopes.includes(scope)))
    throw new AppError("SCOPES_MISSING");
  return scopes;
}
export function publicStatus(status, profile, record, storage, error) {
  return {
    status,
    profile: profile.name,
    account: profile.account,
    requestedScopes: [...resolveScopes(profile.scopes)],
    grantedScopes: record ? [...record.grantedScopes] : [],
    expiresAt: record
      ? new Date(record.tokens.expiry_date).toISOString()
      : null,
    storage: { ...storage },
    ...(error ? publicError(error) : {}),
  };
}
function redirectFor(client, profile) {
  if (client.type === "installed") {
    if (profile.redirectUri !== undefined) throw new AppError("INVALID_CONFIG");
    return new URL("http://127.0.0.1:0/oauth/callback");
  }
  let url;
  try {
    url = new URL(profile.redirectUri);
  } catch {
    throw new AppError("INVALID_CONFIG");
  }
  if (
    !client.redirectUris.includes(profile.redirectUri) ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/complete"
  )
    throw new AppError("INVALID_CONFIG");
  return url;
}
const sameState = (expected, actual) =>
  typeof actual === "string" &&
  Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

export async function startAuth(
  profile,
  {
    oauthFactory: factory = oauthFactory,
    now = Date.now,
    timeoutMs = 30 * 60 * 1000,
    store,
    configDir,
    env = process.env,
    op,
  } = {},
) {
  ({ profile, configDir } = await prepareProfile(profile, { configDir }));
  const requestedScopes = resolveScopes(profile.scopes);
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30 * 60 * 1000
  )
    throw new AppError("INVALID_CONFIG");
  let client = await loadClient(profile.clientSource, { env, op });
  const redirect = redirectFor(client, profile);
  store ??= createStore(profile.store, { env, op });
  await store.preflight();
  let oauth, pending, savedMetadata, timer, closeTimer, commit, cancelReason;
  let stage = "pending",
    error,
    consumed = false,
    settled = false;
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  let verifier = randomBytes(48).toString("base64url");
  const deadline = now() + timeoutMs;
  const id = randomBytes(16).toString("hex");
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const status = () =>
    publicStatus(
      stage,
      profile,
      stage === "saved"
        ? savedMetadata
        : stage === "save-failed"
          ? pending
          : undefined,
      store.reference,
      error,
    );
  const close = () => {
    clearTimeout(closeTimer);
    server.close();
    server.closeAllConnections();
  };
  const clearSecrets = () => {
    pending = undefined;
    verifier = undefined;
    oauth?.setCredentials({});
    oauth = undefined;
    client = undefined;
  };
  const settle = () => {
    if (!settled) {
      const result = status();
      settled = true;
      resolveDone(result);
    }
  };
  const stop = (reason) => {
    stage = reason === "AUTH_EXPIRED" ? "expired" : "cancelled";
    error = new AppError(reason);
    clearSecrets();
    clearTimeout(timer);
    close();
    settle();
  };
  const guard = () => {
    if (cancelReason) throw new AppError(cancelReason);
    if (now() >= deadline) {
      cancelReason = "AUTH_EXPIRED";
      stop(cancelReason);
      throw new AppError(cancelReason);
    }
    if (stage === "cancelled" || stage === "expired") throw error;
  };
  async function cancel(reason = "AUTH_CANCELLED") {
    if (
      stage === "saved" ||
      stage === "failed" ||
      stage === "cancelled" ||
      stage === "expired"
    ) {
      close();
      return status();
    }
    cancelReason = reason;
    // Persistence is a commit boundary: never acknowledge cancellation before an already-started write settles.
    if (commit) {
      await commit;
      if (stage !== "saved") stop(reason);
      else close();
    } else stop(reason);
    return status();
  }
  async function save() {
    if (stage === "saved") throw new AppError("INVALID_CONFIG");
    guard();
    if (!pending || !["verifying", "save-failed"].includes(stage))
      throw new AppError("INVALID_CONFIG");
    stage = "saving";
    error = undefined;
    commit = (async () => {
      try {
        const reference = await store.write(pending);
        if (!isDeepStrictEqual(await store.read(), pending))
          throw new AppError("STORE_MISMATCH");
        if (profile.store.kind === "1password") {
          if (!reference?.item) throw new AppError("STORE_MISMATCH");
          profile.store = { ...profile.store, item: reference.item };
          delete profile.store.title;
        }
        await saveProfile(profile, { configDir });
        stage = "saved";
        clearTimeout(timer);
        oauth?.setCredentials({});
        oauth = undefined;
        verifier = undefined;
        // Public metadata is retained; secret record is cleared once its status has been captured.
        savedMetadata = {
          grantedScopes: [...pending.grantedScopes],
          tokens: { expiry_date: pending.tokens.expiry_date },
        };
        pending = undefined;
        client = undefined;
      } catch (e) {
        stage = "save-failed";
        error = e instanceof AppError ? e : new AppError("STORE_FAILED");
      }
    })();
    await commit;
    commit = undefined;
    if (cancelReason && stage !== "saved") stop(cancelReason);
    return status();
  }
  const respond = (res, code, text) => {
    res.writeHead(code, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
      "Referrer-Policy": "no-referrer",
    });
    res.end(text);
  };
  const completion = (res) => {
    if (res.destroyed) {
      close();
      settle();
      return;
    }
    res.once("finish", settle);
    res.once("close", settle);
    res.writeHead(303, {
      Location: "/complete",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      Connection: "close",
    });
    res.end();
    closeTimer = setTimeout(close, 1000);
    closeTimer.unref();
  };
  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, redirect.origin);
    } catch {
      respond(res, 400, "Invalid callback.");
      return;
    }
    if (
      req.method === "GET" &&
      req.headers.host === redirect.host &&
      url.pathname === "/complete" &&
      ["saved", "failed", "save-failed"].includes(stage) &&
      !url.search
    ) {
      respond(
        res,
        200,
        stage === "saved"
          ? "Authentication saved. You can close this window."
          : "Authentication did not complete. Return to Grantloom for the status.",
      );
      res.on("finish", close);
      return;
    }
    if (
      req.method !== "GET" ||
      req.headers.host !== redirect.host ||
      url.origin !== redirect.origin ||
      url.pathname !== redirect.pathname ||
      [...new Set(url.searchParams.keys())].some(
        (k) => url.searchParams.getAll(k).length !== 1,
      ) ||
      !sameState(state, url.searchParams.get("state")) ||
      !!url.searchParams.get("code") === !!url.searchParams.get("error")
    ) {
      respond(res, 400, "Invalid callback.");
      return;
    }
    if (consumed) {
      respond(res, 409, "Callback already used.");
      return;
    }
    consumed = true;
    try {
      guard();
      if (url.searchParams.has("error")) throw new AppError("OAUTH_DENIED");
      stage = "verifying";
      const { tokens } = await oauth.getToken({
        code: url.searchParams.get("code"),
        codeVerifier: verifier,
        redirect_uri: redirect.href,
      });
      guard();
      if (!tokens?.refresh_token) throw new AppError("REFRESH_MISSING");
      if (!tokens.access_token || !tokens.id_token)
        throw new AppError("TOKEN_INVALID");
      const ticket = await oauth.verifyIdToken({
        idToken: tokens.id_token,
        audience: client.clientId,
      });
      guard();
      const claims = ticket.getPayload();
      if (!claims || claims.nonce !== nonce || claims.aud !== client.clientId)
        throw new AppError("TOKEN_INVALID");
      if (
        claims.email_verified !== true ||
        typeof claims.email !== "string" ||
        claims.email.toLowerCase() !== profile.account.toLowerCase()
      )
        throw new AppError("ACCOUNT_MISMATCH");
      const initial = await oauth.getTokenInfo(tokens.access_token);
      guard();
      const granted = verifyTokenInfo(
        initial,
        client.clientId,
        profile.account,
        requestedScopes,
        now,
      );
      oauth.setCredentials(tokens);
      const { credentials } = await oauth.refreshAccessToken();
      guard();
      if (!credentials?.access_token) throw new AppError("TOKEN_INVALID");
      const info = await oauth.getTokenInfo(credentials.access_token);
      guard();
      const refreshedScopes = verifyTokenInfo(
        info,
        client.clientId,
        profile.account,
        requestedScopes,
        now,
      );
      if (!isDeepStrictEqual([...granted].sort(), [...refreshedScopes].sort()))
        throw new AppError("SCOPES_MISSING");
      const timestamp = new Date(now()).toISOString();
      pending = validateRecord({
        version: 1,
        account: profile.account,
        client: {
          clientId: client.clientId,
          clientSecret: client.clientSecret,
        },
        requestedScopes,
        grantedScopes: refreshedScopes,
        tokens: {
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token || tokens.refresh_token,
          expiry_date: info.expiry_date,
        },
        obtainedAt: timestamp,
        verifiedAt: timestamp,
      });
      await save();
      if (stage !== "cancelled" && stage !== "expired") completion(res);
    } catch (e) {
      if (cancelReason || stage === "cancelled" || stage === "expired") {
        if (!cancelReason) cancelReason = error.code;
        stop(cancelReason);
        return;
      }
      stage = "failed";
      error = e instanceof AppError ? e : new AppError("OAUTH_FAILED");
      clearSecrets();
      clearTimeout(timer);
      completion(res);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 10000;
  server.keepAliveTimeout = 1;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(redirect.port), "127.0.0.1", resolve);
    });
    redirect.port = String(server.address().port);
    oauth = factory({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: redirect.href,
    });
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: requestedScopes,
      login_hint: profile.account,
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    timer = setTimeout(() => {
      void cancel("AUTH_EXPIRED");
    }, timeoutMs);
    return {
      id,
      url,
      redirectUri: redirect.href,
      status,
      done,
      retrySave: async () => {
        if (commit) return commit.then(status);
        const result = await save();
        settle();
        return result;
      },
      cancel: () => cancel(),
    };
  } catch {
    clearSecrets();
    close();
    throw new AppError("OAUTH_FAILED");
  }
}
