import { runCLI } from "../src/cli.js";
import { refreshProfile } from "../src/service.js";
import { fakeOAuth, env, customScope } from "./oauth.js";
const mode = process.argv[2];
const dir = process.argv[3];
const fake = fakeOAuth();
const services = {};
if (mode === "refresh") {
  services.refreshProfile = (name, options) =>
    refreshProfile(name, {
      ...options,
      oauthFactory: (config) => {
        const oauth = fake.factory(config);
        oauth.refreshAccessToken = async () => {
          throw new Error("synthetic-refresh-token synthetic-client-secret");
        };
        return oauth;
      },
    });
}
const authOptions = { oauthFactory: fake.factory };
let writes = 0;
if (mode === "interactive") {
  Object.defineProperty(process.stdin, "isTTY", { value: true });
  authOptions.store = {
    preflight: async () => {},
    reference: { kind: "json", path: "synthetic" },
    write: async (record) => {
      if (++writes === 1) throw new Error("synthetic-refresh-token");
      return { kind: "json", path: "synthetic" };
    },
    read: async () => saved,
  };
  let saved;
  const write = authOptions.store.write;
  authOptions.store.write = async (record) => {
    const ref = await write(record);
    saved = record;
    return ref;
  };
}
const open = async (url) => {
  if (mode === "cancel") {
    process.stderr.write("READY\n");
    return false;
  }
  const consent = new URL(url);
  const callback = new URL(consent.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", consent.searchParams.get("state"));
  callback.searchParams.set("code", "synthetic-code");
  await fetch(callback);
  return false;
};
const args =
  mode === "refresh"
    ? ["refresh", "--profile", "synthetic", "--json"]
    : mode === "interactive"
      ? ["auth", "--json"]
      : [
          "auth",
          "--client-env",
          "TEST_CLIENT",
          "--account",
          "student@example.com",
          "--scope",
          customScope,
          "--store",
          "json",
          "--output",
          `${dir}/cancel.json`,
          "--profile",
          "cancelled",
          "--json",
        ];
process.exitCode = await runCLI(args, {
  env: { ...process.env, ...env },
  authOptions,
  open,
  services,
});
