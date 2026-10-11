import { OAuth2Client } from "google-auth-library";
export const clientId = "synthetic.apps.googleusercontent.com";
export const clientSecret = "synthetic-client-secret";
export const account = "student@example.com";
export const customScope = "https://www.googleapis.com/auth/tasks.readonly";
export const scopes = [customScope, "openid", "email"];
export const env = {
  TEST_CLIENT: JSON.stringify({
    installed: { client_id: clientId, client_secret: clientSecret },
  }),
};
export function profile(dir) {
  return {
    version: 1,
    name: "synthetic",
    account,
    clientSource: { env: "TEST_CLIENT" },
    store: { kind: "json", path: `${dir}/tokens.json` },
    scopes: [customScope],
  };
}
export function fakeOAuth(options = {}) {
  const calls = [];
  let oauth;
  const factory = (config) => {
    oauth = new OAuth2Client(config);
    oauth.getToken = async (request) => {
      calls.push(["exchange", request]);
      if (options.wait) await options.wait;
      if (options.error)
        throw new Error("synthetic-access-token synthetic-client-secret");
      return {
        tokens: {
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          id_token: "synthetic-id-token",
          expiry_date: Date.now() + 3600000,
          ...options.tokens,
        },
      };
    };
    oauth.verifyIdToken = async (request) => {
      calls.push(["verify", request]);
      const nonce = new URL(oauth.authUrl).searchParams.get("nonce");
      return {
        getPayload: () => ({
          aud: clientId,
          nonce,
          email: account,
          email_verified: true,
          ...options.payload,
        }),
      };
    };
    oauth.getTokenInfo = async (token) => {
      calls.push(["info", token]);
      return {
        aud: clientId,
        email: account,
        email_verified: true,
        scopes: [
          customScope,
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
        expiry_date: Date.now() + 3600000,
        ...options.info,
        ...(token === "synthetic-refreshed-token" ? options.refreshedInfo : {}),
      };
    };
    oauth.refreshAccessToken = async () => {
      calls.push(["refresh"]);
      return {
        credentials: {
          access_token: "synthetic-refreshed-token",
          expiry_date: Date.now() + 3600000,
          ...options.refreshed,
        },
      };
    };
    const generate = oauth.generateAuthUrl.bind(oauth);
    oauth.generateAuthUrl = (opts) => (oauth.authUrl = generate(opts));
    return oauth;
  };
  return {
    factory,
    calls,
    get oauth() {
      return oauth;
    },
  };
}
export function callback(session, params = {}) {
  const url = new URL(session.redirectUri);
  url.searchParams.set("state", new URL(session.url).searchParams.get("state"));
  url.searchParams.set("code", "synthetic-code");
  for (const [k, v] of Object.entries(params))
    v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v);
  return url;
}
