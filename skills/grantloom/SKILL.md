---
name: grantloom
description: Use when a user wants Google OAuth consent with their own client, configurable account/scopes and credential destination, or wants to refresh or inspect a saved Grantloom profile.
---

# Grantloom

Use the CLI first (`npx --yes grantloom@0.1.0`); use MCP when browser consent must remain pending asynchronously. Run `--help` for descriptor flags.

Ask for missing client source (JSON path, JSON environment-variable name, or 1Password vault/item/field names), intended account, scopes, store/destination, and profile name. Desktop is standard. Web requires JSON input with an exactly registered HTTP loopback URI; op sources have no registered redirect URI list. Keep personal configuration outside public repositories.

Example with existing desktop op login:

```sh
grantloom auth --client-op-item CLIENT_ITEM_ID --op-vault CLIENT_VAULT_ID \
  --client-id-field username --client-secret-field credential \
  --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title 'Google OAuth personal' --profile personal --json
```

A service account is optional: `OP_SERVICE_ACCOUNT_TOKEN` is the default when set; `--op-token-env` names another variable. Accept references, never token values.

`scopes --json` lists candidates. Enabled APIs require separate Cloud read credentials and a project ID. Without them the state is unverified; failed Cloud reads are unavailable, and manual scopes still work. API enablement does not grant OAuth permission. Never enable APIs or silently add Cloud scopes. Auth adds `openid` and `email` for account verification.

Before browser consent, show the selected account, full scopes, and storage reference. Hand login/MFA/consent to the user and keep the CLI running. Its final `saved` status means account/scope checks, refresh round-trip, persistence, and readback completed. Report only status, account, requested/granted scopes, expiry, profile, and storage reference; do not inspect credentials to prove success.

For MCP, `auth_start` takes a secret-free Profile descriptor and returns session `id`/consent `url`/metadata. Poll `auth_status` with that ID. One active session is allowed. On `save-failed`, fix destination access and type `retry` in the same interactive CLI session, or call `auth_save_retry` with the same ID. Do not repeat consent unnecessarily. Ctrl-C/`auth_cancel` cancels; persistence already started is awaited, successful commits remain saved, and failed persistence can leave partially saved credentials. No rollback or token revocation is promised.

Use `status --profile NAME --json` for metadata; it does not refresh remotely. Use `refresh --profile NAME --json` for expired access tokens. Refresh tokens can expire, and Workspace policies can block consent.

Never read/preview credential, client, or env files into agent context, fetch revealed op fields directly, print secret environment variables, or pass secrets as arguments. `exec` is only for a trusted user-requested child: do not use environment dumps or token-printing scripts to check authentication. MCP has no exec tool. Windows requires 1Password; local JSON/env stores are unsupported.
