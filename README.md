# Grantloom

Bring your own Google OAuth client, consent in your system browser, and save verified credentials to a private JSON file, environment file, or 1Password. Grantloom is an independent project, not a Google product. The CLI is the primary interface; MCP and the bundled agent Skill use the same OAuth and storage operations.

Requires Node.js 22 or newer. macOS and Linux support all stores. Windows supports 1Password; local JSON and environment credential stores fail explicitly because POSIX modes do not protect Windows files. Windows profile files contain only validated references and account/scope metadata, use atomic writes/readback, and reject symlinks/junctions; they rely on your OS user-directory permissions, not a POSIX mode/ACL guarantee. Browser launch uses `open`, `xdg-open`, or Windows `rundll32.exe` without a shell. If launching fails, open the displayed URL yourself; the CLI keeps waiting. `--no-open` always leaves opening to you.

## Install and authenticate

```sh
npm install -g grantloom
# Or run without a global install:
npx --yes grantloom@0.1.0 auth
```

With a terminal, `auth` asks for client source, account, scopes, store, destination, and profile name. It shows scope candidates with their API enablement state, then the chosen account, full scope list, and storage reference before browser consent. Missing descriptors without a terminal produce `INVALID_CONFIG` and exit 2. Secrets have no command-line options: pass paths, variable names, and item references only.

Create an OAuth client in your own Google Cloud project and configure the consent screen and allowed test users. Use a **Desktop** client for the usual flow:

```sh
npx --yes grantloom@0.1.0 auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly,calendar.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/personal.json" \
  --profile personal --json
```

The client file is Google's downloaded client JSON, with an `installed` or `web` object. Keep it outside your public checkout and protect it. Grantloom saves the source descriptor under `~/.config/grantloom` (private modes on macOS/Linux); set `GRANTLOOM_CONFIG_DIR` to use another private directory. Keep the referenced client available for `status`, `refresh`, and `exec`.

For a variable containing that JSON, load it locally without printing it, then name the variable:

```sh
export GOOGLE_OAUTH_CLIENT_JSON="$(< "$HOME/.config/google/desktop-client.json")"
grantloom auth --client-env GOOGLE_OAUTH_CLIENT_JSON \
  --account you@example.com --scope drive.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/drive.json" \
  --profile drive
```

For **Web** clients, use JSON/file or JSON/environment input with the exact registered HTTP loopback URI. The URI must include an explicit fixed port and callback path; it must match `web.redirect_uris` exactly. Only IPv4 loopback/localhost is supported. Busy registered ports fail instead of changing ports. Desktop clients choose an ephemeral `127.0.0.1` port and do not accept `--redirect-uri`. Hosted HTTPS callbacks and service-account JSON are not this user-consent flow.

```sh
grantloom auth --client-json "$HOME/.config/google/web-client.json" \
  --redirect-uri http://127.0.0.1:8765/oauth/callback \
  --account you@example.com --scope sheets.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/sheets.json" \
  --profile sheets
```

## 1Password

Install the `op` CLI and either authenticate with your existing desktop integration/`op signin`, or provide a service-account token in a named environment variable using your secret manager. Grantloom does not require a service account. If `OP_SERVICE_ACCOUNT_TOKEN` is set, it is the default; `--op-token-env MY_OP_TOKEN` selects another variable. Never put the token value on the command line.

```sh
grantloom auth --client-op-item OAUTH_CLIENT_ITEM_ID --op-vault CLIENT_VAULT_ID \
  --account you@example.com --scope gmail.full \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title 'Google OAuth personal' --profile personal
```

The default client fields are `client_id`, `client_secret`, and optional `project_id`, with Desktop (`installed`) type. Existing client items with different labels can use:

```sh
grantloom auth --client-op-item OAUTH_CLIENT_ITEM_ID --op-vault CLIENT_VAULT_ID \
  --op-token-env MY_OP_TOKEN --client-id-field username \
  --client-secret-field credential --client-project-field project_id \
  --client-type installed --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title 'Google OAuth personal' --profile personal
```

`--op-vault` also supplies the destination vault unless `--store-vault` overrides it. Use `--title` to create/find a compatible Grantloom item, or `--item TOKEN_ITEM_ID` to select an existing compatible item. The final stable item ID is retained in the profile. An arbitrary existing item lacking Grantloom metadata is not overwritten. `--refresh-field FIELD` can change the refresh-token label. Web clients from `op` currently have no registered redirect URI list, so use JSON input for Web clients.

## Scopes and enabled APIs

Aliases: `gmail.full`, `gmail.readonly`, `gmail.modify`, `gmail.compose`, `drive.full`, `drive.readonly`, `sheets`, `sheets.readonly`, `calendar`, `calendar.readonly`. `--scope` accepts repeated flags or comma-separated values. Custom Google scope URIs such as `https://www.googleapis.com/auth/tasks.readonly` and `https://mail.google.com/` are accepted. Grantloom adds and displays `openid` and `email` to verify the requested account.

```sh
grantloom scopes --json
grantloom scopes --api drive --json
grantloom scopes --project-id YOUR_PROJECT_ID --cloud-token-env CLOUD_READ_TOKEN --json
# Alternative protected token file or 1Password reference:
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-file "$HOME/.config/google/cloud-read-token" --json
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-op op://CLOUD_VAULT_ID/CLOUD_ITEM_ID/access_token --json
```

`--api` requests the official Discovery catalog for that API. Curated versions are Drive v3, Sheets v4, and Calendar v3; other IDs default to v1. APIs needing another version may not be discoverable; manual custom scope URIs still work. Cloud credentials need separate Service Usage read permission to check enabled services. `--cloud-token-env` names a variable holding a Cloud access token; the file contains only that token; `op://VAULT/ITEM/FIELD` is a reference (percent-encode spaces or slashes in its components). These source options are mutually exclusive and also work with `auth`. Auth can infer the project ID from the client JSON; `--project-id` overrides it.

Without Cloud read credentials, enablement is **unverified**. A failed Cloud read is **unavailable**, and manual scope selection still works. Enabled APIs and OAuth permission are different: enabling an API does not grant scopes, and selecting a scope does not enable its API. Grantloom never enables APIs or adds Cloud scopes to your OAuth request.

## Environment files, status, refresh, and exec

```sh
grantloom auth --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly \
  --store env --output "$HOME/.config/grantloom/credentials/personal.env" \
  --prefix GRANTLOOM_PERSONAL --profile personal
```

File stores use private directories (0700), files (0600), atomic replacement, readback verification, and reject unsafe permissions/symlinks. Different account/client/scope records are not silently overwritten. Add only this source line to your own `.zshrc` if you want those exports in new shells; keep token values in the protected file:

```sh
source "$HOME/.config/grantloom/credentials/personal.env"
```

Grantloom does not edit your shell configuration or update the parent shell environment. Environment files export the selected prefix's client/token fields and metadata, including numeric `EXPIRY_DATE`. Never print or share the file.

```sh
grantloom status --profile personal --json
grantloom refresh --profile personal --json
grantloom exec --profile personal -- node ./your-google-api-script.mjs
```

`status` reads saved metadata without contacting Google to refresh. `refresh` verifies the new token's account/client/scopes, saves it, and checks readback. `exec` supplies `GRANTLOOM_CLIENT_ID`, `GRANTLOOM_CLIENT_SECRET`, `GRANTLOOM_ACCESS_TOKEN`, `GRANTLOOM_REFRESH_TOKEN`, and `GRANTLOOM_ACCESS_TOKEN_EXPIRES_AT` (ISO); an environment store's `--prefix` replaces `GRANTLOOM`. It passes arguments without a shell and propagates the child's exit code. Expired access tokens produce `TOKEN_EXPIRED`: run `refresh` explicitly. Only run trusted child commands; their output is their own responsibility and can expose injected credentials.

CLI results, including `--json`, contain metadata only. A typical status has `status`, `profile`, `account`, `requestedScopes`, `grantedScopes`, `expiresAt`, and `storage`. Errors use fixed `code`/`message` pairs. Auth's consent URL and preflight selection go to stderr; its final status goes to stdout. There is no token-printing command. Exit codes: 0 success, 1 runtime failure, 2 invalid configuration, 130 cancellation (or the child's own code for `exec`).

## MCP

Configure a stdio server in your MCP host:

```json
{
  "mcpServers": {
    "grantloom": {
      "command": "npx",
      "args": ["--yes", "grantloom@0.1.0", "mcp"]
    }
  }
}
```

Expose only the named environment variables needed by your descriptors through your host's secret mechanism. The seven tools are `auth_start`, `auth_status`, `auth_save_retry`, `auth_cancel`, `scopes_list`, `refresh`, and `profile_status`. Strict schemas reject unknown keys. No tool prints tokens or executes arbitrary commands.

Example `auth_start` arguments:

```json
{
  "profile": {
    "version": 1,
    "name": "personal",
    "account": "you@example.com",
    "clientSource": {"env": "GOOGLE_OAUTH_CLIENT_JSON"},
    "scopes": ["gmail.readonly"],
    "store": {"kind": "1password", "vault": "TOKEN_VAULT_ID", "title": "Google OAuth personal"}
  }
}
```

`auth_start` returns an `id`, Google consent `url`, and public status immediately. Open the URL in your browser; poll `auth_status` with `{"id":"SESSION_ID"}`. Use the same ID for save retry or cancellation. `refresh` and `profile_status` take `{"profile":"personal"}`. `scopes_list` accepts optional `projectId`, `cloudTokenEnv`, `cloudTokenFile`, `cloudTokenOp` (`{vault,item,field?,tokenEnv?}`), and `api`. Client op descriptors support `clientIdField`, `clientSecretField`, `projectIdField`, and `type`; store op descriptors support `tokenEnv` and `refreshField`.

One active session is allowed, including retained `save-failed` sessions. Disconnecting cancels it and closes the callback listener. Sessions are memory-only and expire after 30 minutes.

## Agent Skill

The npm package includes `skills/grantloom/SKILL.md`. Install it into your agent's skill directory, for example with Codex:

```sh
npm install -g grantloom
mkdir -p "$HOME/.codex/skills/grantloom"
cp "$(npm root -g)/grantloom/skills/grantloom/SKILL.md" "$HOME/.codex/skills/grantloom/SKILL.md"
```

Restart the agent or reload skills. The Skill asks for safe descriptors, uses the CLI first, and hands browser login/consent to you. It prohibits reading secret files, fetching revealed secret fields into context, or displaying token values.

## Troubleshooting and limits

- **Denied consent / Workspace policy:** `OAUTH_DENIED` or `OAUTH_FAILED` can require choosing an allowed test user, correcting the consent screen, or asking your Workspace administrator to allow the application/scopes. Grantloom cannot bypass these restrictions.
- **Wrong account or missing scopes:** Grantloom verifies the actual email and granted scopes. Choose the requested account and consent to every requested scope; `login_hint` alone is not proof of identity.
- **Missing refresh token:** `REFRESH_MISSING` requires consent again. Check the application's consent configuration and Google's issuance policies.
- **Token lifetime:** access tokens expire; use `refresh`. Refresh tokens can also expire or be revoked. External apps in consent-screen Testing usually receive seven-day refresh tokens except identity-only scopes. Password changes involving Gmail scopes, admin policy, revocation, and token issuance limits can invalidate them. See [Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).
- **Save failed:** interactive CLI keeps the verified session and asks `retry` or `cancel`; MCP uses `auth_save_retry`. Retry storage without repeating consent. Noninteractive CLI returns the safe failure and cancels retained credentials when it exits. Fix permissions or destination access before retrying.
- **Cancellation boundary:** Ctrl-C cancels pending consent/verification. Once persistence starts, cancellation/disconnect waits for that write, readback, and profile save. A completed commit still reports saved; a failed commit reports cancellation. There is no rollback, so a partially saved credential can remain after a persistence failure. Check the protected destination before starting again.
- **Local store conflict/unsafe path:** use a private destination for the intended account/client/scopes. A process killed during a file write can leave a `.grantloom.lock`; remove a stale lock only after confirming no Grantloom writer is active. Atomic replacement does not claim crash-proof directory fsync. 1Password updates do not claim remote compare-and-swap.

Authentication uses PKCE S256, state, OIDC nonce/account verification, granted-scope verification, a refresh round-trip, and storage readback. No hosted authentication service is involved. Real browser consent, provider policies, and actual destination permissions remain under your control.

## Development

```sh
npm ci
npm test
npm run check
npm pack --dry-run
```

CI tests Linux/macOS on Node 22/24 and runs targeted profile-descriptor/help checks on Windows Node 24. Tests use synthetic credentials, real local callbacks/file stores, and the official SDK with controlled remote boundaries. Public examples and distribution contain no personal authentication configuration.

MIT license.
