# Grantloom

**Google OAuth, without the unpaid internship in OAuth.**

**English** · [日本語](https://github.com/ryoshin0830/grantloom/blob/main/README.ja.md) · [简体中文](https://github.com/ryoshin0830/grantloom/blob/main/README.zh-CN.md)

You wanted a script to read your calendar. Somehow you now have six browser tabs, three kinds of credentials, and a refresh token you are afraid to look at.

Grantloom handles the permission paperwork: bring your own Google OAuth client, approve access in your browser, and save verified credentials to **1Password, a private JSON file, or an environment file**. Your scripts can use those credentials through a child process. Your AI agent can coordinate the workflow through the CLI, MCP, or the bundled Skill.

An independent project, unaffiliated with Google. No hosted authentication service. No account to create with us. Despite the name, no research grants either.

## On this page

- [What can it do?](#what-can-it-do)
- [First successful login](#first-successful-login)
- [Where do the files live?](#where-do-the-files-live)
- [Three ways to supply your OAuth client](#three-ways-to-supply-your-oauth-client)
- [Three places to save credentials](#three-places-to-save-credentials)
- [Scopes: choose the keys you actually need](#scopes-choose-the-keys-you-actually-need)
- [Every CLI command](#every-cli-command)
- [CLI option reference](#cli-option-reference)
- [MCP: seven tools for your agent](#mcp-seven-tools-for-your-agent)
- [The bundled agent Skill](#the-bundled-agent-skill)
- [What happens during authentication?](#what-happens-during-authentication)
- [Troubleshooting](#troubleshooting)
- [Development and license](#development-and-license)

## What can it do?

| You want to… | Grantloom does… |
| --- | --- |
| Authorize a script for Gmail, Drive, Sheets, Calendar, or another Google API | Runs browser consent for your scopes and checks the actual account and permissions |
| Keep tokens out of chat and terminal output | Returns metadata; credentials go directly to your chosen store |
| Separate work and personal access | Saves named profiles with their own client references, account, scopes, and destination |
| Obtain a fresh access token | Refreshes an existing profile, verifies the result, and updates the same store |
| Let a script use credentials | `exec` injects credentials into that script's environment |
| Let an AI agent coordinate authentication | Provides a CLI, seven MCP tools, and an agent Skill |
| See which permissions exist | Lists common scope candidates, optional API Discovery scopes, and optionally enabled APIs |

Grantloom manages **authorization and credentials**. It does not itself read your inbox, send email, edit spreadsheets, or organize your Drive. Those jobs belong to the program using the credentials. Grantloom is the key desk, not the entire hotel staff.

It does not enable Google APIs, bypass Workspace policies, automatically refresh in the background, or revoke tokens when you delete a local file. There is no token-printing command and no MCP tool for arbitrary command execution.

### Tiny glossary. There will be no exam.

| Term | In plain English |
| --- | --- |
| OAuth client | Identifies your application to Google; not your Google account |
| Account | The Google user who is granting access |
| Scope | A permission you ask that user to grant |
| Access token | A time-limited credential your program uses to call an API |
| Refresh token | A credential used to obtain a new access token without repeating browser consent, while it remains valid |
| Profile | A local name and saved references for one account/client/scope/storage setup |

## First successful login

### 1. Bring the ingredients

- **Node.js 22+** and npm.
- A Google account and a Google Cloud project you can configure.
- A Google OAuth client. A **Desktop app** client is the simplest choice.
- A browser for Google login, MFA, and consent.
- Optional: [1Password CLI](https://developer.1password.com/docs/cli/get-started/) for vault storage.

| Platform | JSON / environment credential files | 1Password |
| --- | --- | --- |
| macOS / Linux | Supported | Supported with `op` |
| Windows | Explicitly unsupported | Supported with `op` |

Shell examples use bash/zsh syntax. On Windows, use 1Password and adapt multiline commands to your shell. Profile metadata is still saved locally on Windows; protection relies on your OS user-directory permissions.

### 2. Create your Google OAuth client

In your Google Cloud project:

1. Enable the APIs your program will call.
2. Configure the OAuth consent screen / audience and add your account as a test user if the app is in Testing.
3. Create an OAuth client with application type **Desktop app**.
4. Download its JSON file and place it somewhere private, for example `$HOME/.config/google/desktop-client.json`.

The file has an `installed` object with fields such as `client_id`, `client_secret`, and optionally `project_id`. A service-account key is a different credential and cannot be used here. Google's [desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) covers the setup.

Keep the client outside your repository. On macOS/Linux, use the following permissions after placing the download at the example path. Grantloom reads this input; it does not secure your original download for you.

```sh
mkdir -p "$HOME/.config/google"
chmod 700 "$HOME/.config/google"
chmod 600 "$HOME/.config/google/desktop-client.json"
```

### 3. Install, or just borrow it with npx

```sh
npm install -g grantloom@0.1.0
grantloom --help
```

Prefer no global installation? Run `npx --yes grantloom@0.1.0 auth`. The same `npx --yes grantloom@0.1.0` prefix works for all commands below.

### 4. Ask nicely, then let Google ask officially

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com \
  --scope gmail.readonly,calendar.readonly \
  --store json \
  --output "$HOME/.config/grantloom/credentials/personal.json" \
  --profile personal \
  --json
```

Replace `you@example.com` with your account. Paths and item IDs in this guide are examples, not bundled personal configuration.

Grantloom shows the account, full requested scopes, and destination, then opens Google consent. Pick the requested account and approve the requested access. Keep the CLI running until it reports `saved`.

Running just `grantloom auth` in a terminal asks for the client source, account, scopes, storage kind, destination, and profile name. An empty scope selection requests identity only. Without an interactive terminal, provide every required setting; missing settings fail with `INVALID_CONFIG` and exit code `2`.

Browser did not open? Use the displayed Google consent URL. `--no-open` disables automatic opening, not consent. The callback server runs on your machine; SSH/container use needs a way for the browser to reach that machine's loopback callback.

### 5. Check it, refresh it, use it

```sh
grantloom status --profile personal --json
grantloom refresh --profile personal --json
grantloom exec --profile personal -- node ./your-google-api-script.mjs
```

The last command expects a script you supply; Grantloom does not create it. See [Every CLI command](#every-cli-command) for its environment variables.

## Where do the files live?

There are **three different things**. Naming all of them `credentials.json` is how a quiet afternoon becomes a detective series.

| Thing | Created by | Example location | Contents |
| --- | --- | --- | --- |
| **OAuth client input** | You / Google Cloud | `~/.config/google/desktop-client.json` | App client ID, client secret, and project information |
| **Profile** | Grantloom after a successful save | `~/.config/grantloom/personal.json` | Account, scopes, client source reference, store reference; no tokens or client secret |
| **Credential record** | Grantloom | The exact `--output` path, or a 1Password item | Client ID/secret, access/refresh tokens, expiry, account, scopes, verification timestamps |

With the quick-start JSON example:

```text
~/.config/
├── google/
│   └── desktop-client.json        ← you provide; sensitive input
└── grantloom/
    ├── personal.json              ← profile; references and metadata
    └── credentials/
        └── personal.json          ← actual credentials; sensitive
```

For `--store env`, choose a path such as `credentials/personal.env`. With `--store 1password`, credentials live in the vault; the local profile still exists. The original client source stays wherever you put it.

**The credential destination is explicit.** Grantloom asks for it or uses your flags; it does not silently choose the example path.

**Profiles:** the default is `$HOME/.config/grantloom/<profile>.json`. Set `GRANTLOOM_CONFIG_DIR` to change the profile directory. This does not move the original client or change a destination selected with `--output`. Use the same setting on later invocations. Profile names use lowercase letters, digits, and hyphens, start with a letter/digit, and are 1–63 characters long.

**Keep the original client available.** `status`, `refresh`, and `exec` reload it. File sources must remain readable; environment sources must be set in each process; 1Password sources need working `op` access.

**Local files are plaintext, not encrypted.** On macOS/Linux, credential files and profiles use private permissions (directories `0700`, files `0600`), atomic replacement, and symlink/unsafe-path checks. Other processes running as your user may still read them. Choose 1Password for vault storage. Profiles contain personal metadata such as account email and paths, so keep those private too.

Use separate profile names and destinations for separate accounts or permission sets. Grantloom rejects incompatible account/client/scope records at a credential destination.

## Three ways to supply your OAuth client

Choose **one** source. These options describe where the client lives; they do not contain its secret.

| Source | Option | What must exist |
| --- | --- | --- |
| Google client JSON file | `--client-json PATH` | Readable JSON with `installed` or `web` |
| Environment variable | `--client-env VARIABLE_NAME` | A variable containing the entire client JSON |
| 1Password item | `--client-op-item ITEM_ID --op-vault VAULT_ID` | An accessible item with the required client fields |

For an environment source, load the JSON locally without printing it, then pass the **variable name**:

```sh
export GOOGLE_OAUTH_CLIENT_JSON="$(< "$HOME/.config/google/desktop-client.json")"
grantloom auth \
  --client-env GOOGLE_OAUTH_CLIENT_JSON \
  --account you@example.com --scope drive.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/drive.json" \
  --profile drive
```

For 1Password, default field labels are `client_id`, `client_secret`, and optional `project_id`; the default client type is `installed`. Map different field labels like this:

```sh
grantloom auth \
  --client-op-item OAUTH_CLIENT_ITEM_ID --op-vault CLIENT_VAULT_ID \
  --client-id-field username --client-secret-field credential \
  --client-project-field project_id --client-type installed \
  --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title "Google OAuth personal" --profile personal
```

### Already have a Web client?

Use JSON file/environment input and a registered **HTTP IPv4 loopback** URI with an explicit fixed port and callback path. `--redirect-uri` must exactly match an entry in `web.redirect_uris`. Busy registered ports fail rather than changing.

```sh
grantloom auth \
  --client-json "$HOME/.config/google/web-client.json" \
  --redirect-uri http://127.0.0.1:8765/oauth/callback \
  --account you@example.com --scope sheets.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/sheets.json" \
  --profile sheets
```

Desktop clients use an available `127.0.0.1` port and reject `--redirect-uri`. Web clients may use `127.0.0.1` or `localhost`; IPv6 and hosted HTTPS callbacks are unsupported here. A 1Password client source has no registered redirect list, so use JSON input for Web clients.

## Three places to save credentials

Client source and credential destination are independent. You can read a client from a file and save tokens to 1Password.

### JSON: for programs that like structured data

Use `--store json --output PATH`. The record contains:

| Field | Meaning |
| --- | --- |
| `version`, `account` | Record format and verified account |
| `client.clientId`, `client.clientSecret` | OAuth client credentials |
| `requestedScopes`, `grantedScopes` | Requested and actually granted permissions |
| `tokens.access_token`, `tokens.refresh_token` | Credentials; keep private |
| `tokens.expiry_date` | Access-token expiry, Unix milliseconds |
| `obtainedAt`, `verifiedAt` | ISO acquisition / verification timestamps |

You do not need to open this file to check success. `status` exists so your tokens do not have to make a public appearance.

### Environment file: for shells that like exports

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly \
  --store env --output "$HOME/.config/grantloom/credentials/personal.env" \
  --prefix GRANTLOOM_PERSONAL --profile personal
```

This file contains quoted `export` assignments. Suffixes are `VERSION`, `ACCOUNT`, `CLIENT_ID`, `CLIENT_SECRET`, `REQUESTED_SCOPES`, `GRANTED_SCOPES`, `ACCESS_TOKEN`, `REFRESH_TOKEN`, `EXPIRY_DATE`, `OBTAINED_AT`, and `VERIFIED_AT`. Scope lists are JSON strings; `EXPIRY_DATE` is Unix milliseconds. The default prefix is `GRANTLOOM`, not the profile name.

Load it into your current bash/zsh shell:

```sh
source "$HOME/.config/grantloom/credentials/personal.env"
```

Source only a file you trust. If desired, add that **source line** to your shell startup file yourself. Grantloom does not edit `.zshrc` or change its parent shell's environment. Refresh updates the file; a running shell must source it again. For a single script, `exec` avoids loading credentials into your interactive shell.

### 1Password: for keys that deserve a vault

Authenticate `op` through existing desktop integration / `op signin`, or let your secret manager provide a service-account token. A 1Password service account is optional and unrelated to a Google service-account JSON key.

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title "Google OAuth personal" --profile personal
```

- `--title` creates a new item or finds a compatible Grantloom item. Duplicate matching titles fail.
- `--item TOKEN_ITEM_ID` selects an existing compatible item instead. Do not combine it with `--title`.
- An arbitrary item without Grantloom metadata is not overwritten.
- `--store-vault` selects the destination vault; when omitted, `--op-vault` can supply it.
- The stable item ID is saved in the profile. Unrelated fields in a compatible item are retained.
- Stored labels: `version`, `account`, `client_id`, `client_secret`, `requested_scopes`, `granted_scopes`, `access_token`, `refresh_token`, `expiry_date`, `obtained_at`, `verified_at`. Secrets/tokens use `CONCEALED`. `--refresh-field FIELD` changes the refresh-token label.

When `OP_SERVICE_ACCOUNT_TOKEN` is set, the CLI uses it by default. `--op-token-env MY_OP_TOKEN` selects another variable **by name**. Grantloom passes secrets to `op` internally and does not forward its raw stdout/stderr.

## Scopes: choose the keys you actually need

A **scope** is a permission. Read-only access is a library card; full access is closer to getting the building keys. Pick what your program needs.

| Alias | Permission |
| --- | --- |
| `gmail.full` | Full Gmail access |
| `gmail.readonly` | Read Gmail messages |
| `gmail.modify` | Read and modify Gmail messages |
| `gmail.compose` | Compose and send Gmail messages |
| `drive.full` | Full Drive access |
| `drive.readonly` | Read Drive files |
| `sheets` | Read and edit spreadsheets |
| `sheets.readonly` | Read spreadsheets |
| `calendar` | Read and edit calendars |
| `calendar.readonly` | Read calendars |

`--scope` accepts comma-separated values or repeated flags. Custom Google scope URIs such as `https://www.googleapis.com/auth/tasks.readonly` and `https://mail.google.com/` work too. Grantloom always adds and displays `openid` and `email` to verify the account.

```sh
grantloom scopes --json
grantloom scopes --api drive --json
grantloom scopes --project-id YOUR_PROJECT_ID --cloud-token-env CLOUD_READ_TOKEN --json
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-file "$HOME/.config/google/cloud-read-token" --json
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-op op://CLOUD_VAULT_ID/CLOUD_ITEM_ID/access_token --json
```

**Enabled API ≠ granted permission.** Switching the API on and getting account consent are separate requirements. The door having electricity does not mean you have a key.

Enabled-API checks need a project ID and **separate Cloud read credentials** with Service Usage read permission. A token file contains only the Cloud access token; environment flags take variable names. Use one Cloud source at a time. Percent-encode spaces/slashes inside `op://VAULT/ITEM/FIELD` components.

**Cloud token files need private permissions too.** On macOS/Linux, place the token file in a directory owned by your user with mode `0700`, and use mode `0600` for the file. Unsafe permissions, symlinks, or writable ancestors can make the lookup `unavailable` before any request reaches Google. After creating the token file privately at the example path, set:

```sh
chmod 700 "$HOME/.config/google"
chmod 600 "$HOME/.config/google/cloud-read-token"
```

On Windows, use `--cloud-token-env` or `--cloud-token-op`; the Cloud token-file source is unsupported.

Without Cloud credentials, enablement is `unverified`. Failed listing yields `unavailable`; manual scope selection still works. These flags also work with `auth`, which can infer the project from client JSON; `--project-id` overrides it. Grantloom never enables APIs or adds Cloud scopes to your consent request.

`--api` uses Google's Discovery catalog. Curated versions are Drive v3, Sheets v4, Calendar v3; other IDs default to v1. APIs requiring another version may not be discoverable; supply their scope URI directly.

## Every CLI command

| Command | What happens | Example |
| --- | --- | --- |
| `auth` | Browser consent → verification → storage → profile save | `grantloom auth` |
| `scopes` | List scope candidates and optional enablement metadata | `grantloom scopes --json` |
| `status` | Read saved metadata; no remote refresh | `grantloom status --profile personal --json` |
| `refresh` | Refresh, verify, and update the same destination | `grantloom refresh --profile personal --json` |
| `exec` | Inject credentials into one child process | `grantloom exec --profile personal -- node ./your-google-api-script.mjs` |
| `mcp` | Run a stdio MCP server; the host keeps it alive | `grantloom mcp` |

`auth` is the default command. `--help` and `--version` are available too.

### What does exec give my script?

| Environment variable | Value |
| --- | --- |
| `GRANTLOOM_CLIENT_ID` | Client ID |
| `GRANTLOOM_CLIENT_SECRET` | Client secret |
| `GRANTLOOM_ACCESS_TOKEN` | Current access token |
| `GRANTLOOM_REFRESH_TOKEN` | Refresh token |
| `GRANTLOOM_ACCESS_TOKEN_EXPIRES_AT` | ISO expiry timestamp |

Your Node.js script can read `process.env.GRANTLOOM_ACCESS_TOKEN` and use it with the relevant Google API client. A profile with `--prefix GRANTLOOM_PERSONAL` replaces `GRANTLOOM` with `GRANTLOOM_PERSONAL` in these names.

`exec` passes arguments without a shell and returns the child's exit code. It does not refresh expired tokens; run `refresh` first. Both access and refresh credentials are injected, so run a trusted program. Child output passes through: an environment-printing script can still leak your keys. The key desk cannot stop you photocopying them.

### Output and exit codes

Results contain metadata such as `status`, `account`, `profile`, `requestedScopes`, `grantedScopes`, `expiresAt`, and `storage`. The current CLI emits JSON results even without `--json`; the flag is accepted for explicit intent. Help/version are text; `exec` forwards child output.

For `auth`, prompts, scope candidates, selected settings, and the consent URL go to **stderr**; final status goes to **stdout**. Errors use fixed safe `code` / `message` pairs. No normal result contains tokens or client secrets.

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime failure |
| `2` | Invalid configuration |
| `130` | Cancellation |
| Child's exit code | Returned by `exec` |

## CLI option reference

| Group | Options |
| --- | --- |
| Client source | `--client-json PATH` **or** `--client-env VAR` **or** `--client-op-item ID` |
| 1Password client | `--op-vault VAULT`, `--client-id-field FIELD`, `--client-secret-field FIELD`, `--client-project-field FIELD`, `--client-type installed\|web` |
| 1Password authentication | `--op-token-env VAR` |
| Identity and permissions | `--account EMAIL`, repeatable `--scope ALIAS_OR_URI` |
| Destination | `--store json\|env\|1password`, `--output PATH`, `--prefix PREFIX` |
| 1Password destination | `--store-vault VAULT`, `--item ID` **or** `--title NAME`, `--refresh-field FIELD` |
| Profile and browser | `--profile NAME`, `--redirect-uri URI`, `--no-open` |
| Optional Cloud/API lookup | `--project-id ID`, `--cloud-token-env VAR` **or** `--cloud-token-file PATH` **or** `--cloud-token-op REF`, `--api API` |
| Output / help | `--json`, `--help`, `--version` |

Client, destination, account, browser, and Cloud lookup flags apply to `auth`. Cloud lookup flags also apply to `scopes`; `status`, `refresh`, and `exec` use the saved `--profile`. Flags for the wrong command fail. Secret values have no command-line options: use files, named variables, or 1Password references.

## MCP: seven tools for your agent

MCP lets a compatible AI host call Grantloom's operations. Add a stdio server to your host configuration; the exact configuration file depends on the host:

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

Use your host's secret mechanism for variables that client/store references need. Keep actual secrets out of shared configuration. The host launches and keeps the process running; stdout is reserved for MCP JSON-RPC.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `auth_start` | `{"profile": {…}}` | Start consent; return session `id`, Google `url`, and public status immediately |
| `auth_status` | `{"id":"SESSION_ID"}` | Poll the in-memory session |
| `auth_save_retry` | `{"id":"SESSION_ID"}` | Retry a verified session's failed save without new consent |
| `auth_cancel` | `{"id":"SESSION_ID"}` | Cancel; await persistence if already started |
| `scopes_list` | `{}` or lookup options below | List scopes and optional enablement metadata |
| `refresh` | `{"profile":"personal"}` | Refresh a saved profile; return metadata |
| `profile_status` | `{"profile":"personal"}` | Read saved metadata without remote refresh |

Example `auth_start` arguments with a file client and 1Password destination:

```json
{
  "profile": {
    "version": 1,
    "name": "personal",
    "account": "you@example.com",
    "clientSource": {"file": "/absolute/path/to/desktop-client.json"},
    "scopes": ["gmail.readonly"],
    "store": {
      "kind": "1password",
      "vault": "TOKEN_VAULT_ID",
      "title": "Google OAuth personal"
    }
  }
}
```

Other client sources: `{"env":"GOOGLE_OAUTH_CLIENT_JSON"}` or `{"op":{"vault":"CLIENT_VAULT_ID","item":"OAUTH_CLIENT_ITEM_ID"}}`. File stores use `{"kind":"json","path":"/absolute/private/path/personal.json"}` or `kind: "env"` with optional `prefix`.

`scopes_list` accepts optional `projectId`, `api`, and one of `cloudTokenEnv`, `cloudTokenFile`, `cloudTokenOp`. The last is an object with `vault`, `item`, optional `field` / `tokenEnv`. Client op descriptors support `tokenEnv`, `clientIdField`, `clientSecretField`, `projectIdField`, and `type`; store op descriptors support `item` or `title`, `tokenEnv`, and `refreshField`. Pass variable names, not values. Unknown schema keys are rejected.

The workflow is **start → human opens URL and consents → poll → saved**. One active session is allowed per server, including `save-failed` sessions. Sessions are memory-only and expire after 30 minutes. Disconnecting cancels the session and closes the listener; completed profiles and credentials persist. No tool returns tokens or runs arbitrary child commands.

## The bundled agent Skill

The [Skill](skills/grantloom/SKILL.md) teaches an agent to ask for safe references, use the CLI, and hand browser login/MFA/consent to you. It is an instruction file, not another daemon. A robot can carry the clipboard; it does not get to impersonate your fingerprint.

For agents that read `$HOME/.codex/skills`, install the bundled file like this:

```sh
npm install -g grantloom@0.1.0
mkdir -p "$HOME/.codex/skills/grantloom"
cp "$(npm root -g)/grantloom/skills/grantloom/SKILL.md" \
  "$HOME/.codex/skills/grantloom/SKILL.md"
```

Reload skills as needed. Other agents may use another directory. The Skill prohibits reading credential files or revealed 1Password fields into chat, displaying secret values, and using environment dumps to “verify” authentication. CLI is the primary workflow; MCP is optional.

## What happens during authentication?

1. Validate client/profile settings and check the destination before consent.
2. Start a temporary HTTP callback listener bound to `127.0.0.1`.
3. Open Google consent with PKCE S256, random state, and an OIDC nonce.
4. Check the one-use callback, verify the ID token with Google's official library, and match the verified email to the requested account.
5. Check granted scopes and require a refresh token.
6. Perform a refresh round-trip and verify the refreshed access token.
7. Save credentials, read them back for comparison, and save the profile.
8. Report `saved` with metadata. The tokens remain offstage, where they belong.

Google login/API calls still use Google's services; 1Password storage uses your configured vault access. “No hosted authentication service” means Grantloom does not introduce its own remote authentication backend.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `INVALID_CONFIG` / `INVALID_CLIENT` | Check flags, noninteractive inputs, JSON type, and original client source |
| `STORE_NOT_FOUND` | Check profile name, `GRANTLOOM_CONFIG_DIR`, destination, and 1Password access |
| `STORE_UNSAFE` | Use a private path with safe parent permissions; avoid symlink destinations |
| `STORE_CONFLICT` | Use another destination/profile for a different account, client, or scope set |
| `STORE_AMBIGUOUS` | Resolve duplicate 1Password titles or select the compatible item by ID |
| `ACCOUNT_MISMATCH` | Repeat consent with the requested Google account |
| `SCOPES_MISSING` | Approve every requested scope and check app/admin restrictions |
| `REFRESH_MISSING` | Repeat consent and check Google's refresh-token issuance rules |
| `TOKEN_EXPIRED` | Run `grantloom refresh --profile personal --json`, then retry your script |
| `OAUTH_DENIED` / `OAUTH_FAILED` | Check consent-screen/test-user configuration and Workspace policies |
| `FILE_STORE_UNSUPPORTED` | On Windows, use 1Password |
| Browser does not open | Open the displayed consent URL; keep the CLI alive |

**Save failed?** An interactive CLI retains verified credentials in memory and offers `retry` / `cancel`. MCP provides `auth_save_retry` with the same session ID. Fix destination access and retry within that session. A noninteractive CLI reports failure and clears its retained session on exit.

**Cancelling?** Ctrl-C cancels pending consent/verification. Once persistence starts, cancellation waits for write/readback/profile save. A successful commit stays saved; a failed commit reports cancellation. There is no rollback or token revocation; failed persistence may leave partially saved credentials.

**Tokens stopped working later?** Refresh tokens can expire or be revoked. External apps in Testing generally get seven-day refresh tokens, except identity-only scope sets. Password changes involving Gmail scopes, admin policies, and issuance limits can also matter. See [Google's expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration). A refresh token is renewable access, not a lifetime membership card.

**A stale lock?** A killed writer can leave a `.grantloom.lock` file. Remove it only after confirming no writer is active. File writes use atomic replacement but do not promise directory-fsync crash durability; 1Password updates do not promise remote compare-and-swap.

## Development and license

```sh
npm ci
npm test
npm run check
npm pack --dry-run
```

The code uses Google's official auth library, the official MCP SDK, and Node's built-in HTTP/files/subprocess/test tools. CI covers Linux/macOS on Node 22/24 and targeted Windows profile/help checks on Node 24. Tests use synthetic credentials and controlled remote boundaries.

Documentation: [English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md). Licensed under [MIT](LICENSE).
