# Grantloom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Publish an npx Google OAuth tool with CLI, MCP and Skill, no credential output, configurable scopes and safe storage.

**Architecture:** Small ES modules share the client reader, scope catalog, persistence and OAuth session. The CLI and MCP adapt the same operations. Local HTTP callbacks never log codes; only non-secret metadata leaves the core.

**Tech Stack:** Node.js >=22, ES modules, google-auth-library, @modelcontextprotocol/sdk v1, zod, node:test; Node HTTP/fs/child_process/readline.

## Global Constraints

- Package and executable: grantloom, initial version 0.1.0, public npm, MIT, personal repo ryoshin0830/grantloom.
- Never print, commit or publish real client secrets, access/refresh tokens, authorization codes, 1Password service-account tokens or personal account configuration.
- CLI is primary; MCP and Skill use the same OAuth/persistence operations.
- Google client/account/scopes/destination are configurable. Missing interactive settings are asked before consent; noninteractive missing settings fail safely.
- Desktop OAuth plus Web client with an explicitly registered HTTP loopback redirect URI.
- Enabled APIs need separate Cloud read credentials; no implicit Cloud scope addition or API enabling.
- No hosted authentication service. OAuth consent happens in the system browser.
- Token verification: PKCE S256, state, nonce, one-use callback, 30-minute expiry, verified requested email and requested/granted scopes, refresh round-trip, storage readback.
- 1Password via existing op login or a named service-account environment variable; never secret argument values.
- POSIX file storage: private 0700 directories and 0600 files, atomic writes, no symlink destinations, no silent overwrite of different account/client/scope.
- Local JSON and environment file storage supported on macOS/Linux; Windows file stores must fail explicitly rather than claim POSIX modes protect them. 1Password remains available.
- No token-printing command or MCP tool. exec injects tokens only into the requested subprocess; its output is the subprocess's responsibility.
- TDD for each nontrivial behavior; focused tests while iterating; full tests before commit. Synthetic credentials/accounts only.
- Update TODO.md; implement on feat/oauth-cli; do not push/merge/publish from subagents.

## Data contracts

`ClientSource`: exactly one of `{file}`, `{env}` (variable holding client JSON), or `{op:{vault,item,tokenEnv?,clientIdField?,clientSecretField?,projectIdField?,type?}}`.

`Client`: `{type:'installed'|'web',clientId,clientSecret,projectId?,redirectUris:[]}`.

`StoreOptions`: `{kind:'json'|'env'|'1password',path?,prefix?,vault?,item?,title?,tokenEnv?,refreshField?}`.

`Record`: `{version:1,account,client:{clientId,clientSecret},requestedScopes:[],grantedScopes:[],tokens:{access_token,refresh_token,expiry_date},obtainedAt,verifiedAt}`. This is SECRET and stays internal.

`Profile`: `{version:1,name,account,clientSource,store,scopes:[],redirectUri?}`. Secret values are prohibited in source/store/profile descriptors; filenames, variable names and item IDs are allowed.

`PublicStatus`: `{status,account,requestedScopes,grantedScopes,expiresAt,storage,profile?}` plus a fixed safe error code/message for errors. Never spread a Record, token result or SDK error into an output.

## Task 1: Foundations — configuration, storage, scope listing

**Files:** Create package.json/package-lock.json, src/errors.js, src/config.js, src/stores.js, src/scopes.js, test/config.test.js, test/stores.test.js, test/scopes.test.js.

**Interfaces:**
- `AppError(code,message)` has safe messages; `publicError(error)` always allowlists code/message and never forwards unknown error strings.
- `loadClient(source,{env,op}={}) -> Promise<Client>`; injectable op transport defaults to a subprocess implementation capturing output and passing item JSON via stdin.
- `saveProfile(profile,{configDir}={})`, `loadProfile(name,{configDir}={})`. Default directory ~/.config/grantloom (respect GRANTLOOM_CONFIG_DIR). Profile names use `/^[a-z0-9][a-z0-9-]{0,62}$/`; validate descriptors before write/read.
- `createStore(options,{env,op}={}) -> {preflight(),read(),write(record),reference}`. write returns the final non-secret store reference and preserves stable 1Password item ID. read returns internal Record. preflight checks available destination/auth without storing tokens.
- `resolveScopes(input:string[]) -> string[]`, `listScopes({projectId?,cloudTokenEnv?,cloudTokenFile?,cloudTokenOp?,api?,fetch?,env?,op?}) -> Promise<{enabledStatus,enabledApis,candidates}>`.

- [ ] **Step 1: Write failing config/error tests.** Test file/env/1Password client input, invalid source/type, redacted op error, source descriptor safety and profile name/path confinement. Example:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadClient} from '../src/config.js';
test('env client supports installed credentials', async () => {
  const env = {TEST_CLIENT: JSON.stringify({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'synthetic',project_id:'test-project',redirect_uris:['http://localhost']}})};
  const client = await loadClient({env:'TEST_CLIENT'}, {env});
  assert.equal(client.type, 'installed');
  assert.equal(client.projectId, 'test-project');
});
```

Run `node --test test/config.test.js`; capture the expected missing-module RED output. Create modules and implement validation/reading, using Node fs and captured op CLI calls. Verify GREEN.

- [ ] **Step 2: Write failing storage tests before implementation.** Real temporary-directory tests: record round-trip for JSON and env (including quotes/newlines/dollar/backticks in synthetic secrets), 0600 mode, symlink rejection, unsafe existing permissions, wrong-account/client/scope overwrite rejection, no truncation after failed write. Fake op transport tests validate stdin CONCEALED fields, captured errors, duplicate names, existing ID preservation, wrong-account protections and post-write readback mismatch.

```js
const store = createStore({kind:'json',path:join(dir,'tokens.json')});
await store.preflight();
await store.write(record);
assert.deepEqual(await store.read(),record);
assert.equal((await stat(join(dir,'tokens.json'))).mode & 0o777,0o600);
```

Run `node --test test/stores.test.js` for RED; implement minimum store functions and safe atomic file helper; verify GREEN. Do not shell-evaluate envfiles when reading. Environment export names have a validated prefix and metadata fields to reconstruct Record. Retain unknown existing 1Password fields.

- [ ] **Step 3: Write failing scope tests.** Aliases include gmail.full, gmail.readonly, gmail.modify, gmail.compose, drive.full, drive.readonly, sheets, sheets.readonly, calendar, calendar.readonly; custom https://www.googleapis.com/auth/... or https://mail.google.com/ accepted; always normalize OpenID email scope aliases and dedupe. Candidates carry URI/label/API and enabled status. Request enabled services with `state:ENABLED`, page through nextPageToken; prohibit repeated pagination loops. No Cloud credential means unverified. Discovery API fetch provides scopes for an explicitly selected API using a fixed trusted Google discovery origin, never arbitrary user URLs. Test request/permission failure, pagination, repeated token, malformed response and timeout through injected fetch. Cloud errors remain sanitized and distinguish unavailable listing from actual enabled state.

Run `node --test test/scopes.test.js` for RED; implement catalog/service listing and Discovery scopes; verify GREEN.

- [ ] **Step 4: Create package manifest and install official dependencies.** The manifest uses ESM, engines >=22, bin `grantloom: bin/grantloom.js`, scripts `test: node --test`, `check: node --check bin/grantloom.js`, files whitelist `[bin,src,skills]`, no install hooks. Add the exact installed versions of Google auth library, SDK v1 and zod. Run `npm test` and commit Task 1 with report of RED/GREEN evidence. The missing bin is implemented in Task 3; no check script run until then.

## Task 2: OAuth consent session and profile operations

**Files:** Create src/auth.js, src/service.js, test/auth.test.js, test/service.test.js.

**Interfaces:**
- Consumes Task 1 config/store/scopes/error exports.
- `startAuth(profile,{oauthFactory?,now?,timeoutMs?,store?,configDir?}={}) -> Promise<AuthSession>`.
- `AuthSession` exposes `id`, `url` (Google auth start URL), `redirectUri`, `status()` (PublicStatus), `done` Promise<PublicStatus>, `retrySave()`, `cancel()`. No tokens/client secret on public fields/status. status save-failed allows retry; cancel/timeout clears pending secrets and closes callback listener.
- `refreshProfile(name,{configDir?,oauthFactory?,env?,op?}={}) -> Promise<PublicStatus>`; `profileStatus(name,{configDir?,env?,op?}={}) -> Promise<PublicStatus>`; `profileEnvironment(name,...) -> internal environment map` for CLI exec only.
- One auth session per MCP adapter; separate standalone CLI processes may have independent Desktop callbacks.

- [ ] **Step 1: Write failing real loopback callback tests using fake Google SDK transport.** The fake is only the remote OAuth boundary; exercise real HTTP requests, state/nonce/PKCE logic and persistence. Source of API details is `/tmp/grantloom-planning/library-0.json` or Google official docs. Test:
  - authorization URL offline+consent, PKCE, nonce, account and explicit openid/email scopes;
  - invalid host/path/state, duplicate query parameters and replay rejected without consuming valid session on bogus requests;
  - OAuth denial, valid callback, wrong/unknown/false verified email, nonce/audience mismatch, missing refresh token, scope deficit;
  - successful exchange→verified ID token→getTokenInfo→refresh→getTokenInfo verification before persistence;
  - source client ID matches access token audience; custom scope selection preserved;
  - expired session, user cancellation, callback in-flight cancellation, listener port release;
  - store failure retains pending verified Record, retry saves without another consent, readback mismatch never reports complete;
  - SDK raw error containing synthetic secret never appears in HTTP response or PublicStatus;
  - Web redirect_uri must match configured client redirectUris; bind fixed registered port and path; Desktop uses ephemeral 127.0.0.1 callback.

```js
const session = await startAuth(profile, {oauthFactory:fakeFactory, store:memoryStore});
const authUrl = new URL(session.url);
assert.equal(authUrl.searchParams.get('access_type'),'offline');
assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');
assert(authUrl.searchParams.get('scope').split(' ').includes('openid'));
const callback = new URL(session.redirectUri);
callback.searchParams.set('state',authUrl.searchParams.get('state'));
callback.searchParams.set('code','synthetic-code');
assert.equal((await fetch(callback)).status,200);
assert.equal((await session.done).status,'saved');
```

Run `node --test test/auth.test.js` RED. Implement auth session with official OAuth2Client and Node HTTP; no raw error output, no callback access logging, no unsafe HTML interpolation. Use `getToken({code,codeVerifier,redirect_uri})`, verifyIdToken with audience and separately compare nonce, use refreshed access token info to check account/client/scopes. Close or tightly limit callback connection lifetime. SDK requests must have timeouts. Verify GREEN.

- [ ] **Step 2: Write failing refresh/status/exec-environment tests.** Persist a synthetic record, refresh through fake remote provider and verify new access token/expiry preserved refresh token and granted scope; reject mismatched profile/record account/client/scopes, missing/expired credentials safely. If re-reading client source gives a different client ID, reject before remote refresh. Default status does not perform remote refresh or output token fields. ProfileEnvironment emits only clearly named client/token env vars, not SDK objects.

Run `node --test test/service.test.js` RED; implement service functions using shared store validation/official OAuth methods; verify GREEN. Run full `npm test`, self-review and commit with report.

## Task 3: CLI, MCP, Skill, package and CI

**Files:** Create bin/grantloom.js, src/cli.js, src/mcp.js, skills/grantloom/SKILL.md, README.md, .github/workflows/ci.yml, test/cli.test.js, test/mcp.test.js; adjust package.json only as needed for distribution.

**Interfaces:**
- CLI maps options to the established Profile/ClientSource/StoreOptions contracts. Default auth asks source→account→scope→store→destination→profile. Optional source configuration is saved in profile so refresh/status do not require repeated settings.
- Options: --client-json PATH; --client-env VAR; --client-op-item ID --op-vault VAULT --op-token-env VAR; --account EMAIL; repeatable/comma scopes --scope; --store json|env|1password; --output PATH; --prefix PREFIX; --item ID or --title NAME; --profile NAME; --redirect-uri URI; --project-id ID; --cloud-token-env VAR|--cloud-token-file PATH|--cloud-token-op REF; --api API; --json; --no-open. --op-token-env defaults OP_SERVICE_ACCOUNT_TOKEN when set, otherwise authenticated desktop op CLI. No automatic OPSA dependency for other users.
- MCP tools auth_start/auth_status/auth_save_retry/auth_cancel/scopes_list/refresh/profile_status; auth_start takes secret-free Profile descriptor, creates session and returns URL/id/status; later tools identify session ID; SDK input schemas strict; auth outputs only PublicStatus.

- [ ] **Step 1: Write failing CLI subprocess tests.** help/version, known/unknown command, invalid flags, non-TTY missing account/source/store with fixed safe code, JSON shape, scopes listing, status against real temporary stored synthetic profile, refresh failure/redaction, malformed source files, secret option values rejected. Test `exec` with a synthetic child that checks named environment but prints only yes/no, argument passing without shell, correct child exit-code propagation. CLI auth integration must cover save failure/retry and ctrl-c cleanup with injected boundary or fixture process. No test mode accepted via ordinary unsafe runtime flags.

Run `node --test test/cli.test.js` RED. Implement CLI with Node parseArgs/readline/promises and child_process. Default auth before opening browser shows selected account, full scopes, storage reference. Long browser consent can be asynchronous to external agent but CLI process remains alive. Use Linux xdg-open/macOS open/Windows browser launcher without shell; when opener fails return URL and keep listener alive. Ctrl-C cancels pending session. Exit codes 0 success, 1 runtime, 2 invalid config, 130 cancellation.

- [ ] **Step 2: Write failing MCP integration tests through real SDK client/stdio transport or paired in-memory transport.** listTools exact tool set; non-secret schemas; missing/unknown profile error; scope catalog; auth start/status/cancel; pending save retry; one active session limit; process disconnect cleanup. Confirm neither tool errors nor stderr contain synthetic credential markers. Ensure server stdout contains only JSON-RPC.

Run `node --test test/mcp.test.js` RED. Implement thin MCP adapter and stdio lifecycle. Use official v1 SDK/Zod; source docs `/tmp/grantloom-planning/library-1.json`. Verify GREEN.

- [ ] **Step 3: Add Skill and documentation with usable complete examples.** README: installation, npx auth, env/file/op client sources, scope aliases/custom and enabled API permission distinction, Desktop vs Web callback, 1Password service account vs desktop login, protected envfile/source .zshrc example, refresh/status/exec, metadata-only output, MCP config, Skill install, supported platforms, denied consent/Workspace restrictions/missing refresh/token expiry/save retry. Skill asks for descriptors and prevents reading secret outputs. README examples use you@example.com and placeholder references only. SDK tools do not execute arbitrary subprocesses. Public repo has no personal auth configuration.

- [ ] **Step 4: Add CI and distribution checks.** GitHub Actions ubuntu/macOS Node22/24 matrix runs npm ci, npm test, npm run check, npm pack --dry-run. windows Node24 may verify 1Password-safe CLI help but do not claim file-store support. Run `npm audit --omit=dev`, `git diff --check`, npm pack dry-run manifest inspection, install tarball in private temporary project with --ignore-scripts, invoke its bin --help/status/scopes. Commit and report RED/GREEN/full test evidence.

## Release (controller)

- [ ] Review whole branch with Ponytail Review (read related code, fix findings and retest); verify complete design checklist.
- [ ] Push feat/oauth-cli; create a PR to main using gh --body-file; inspect CI/checks; fix failures; merge to main and verify PR MERGED and remote main commit.
- [ ] Log into npm via web flow; user handles MFA if required. Confirm npm whoami. Publish version 0.1.0 from verified main package; never print auth tokens.
- [ ] Verify npm registry version/dist/bin/repository and published `npx --yes grantloom@0.1.0 --help`, MCP startup/tool listing. Save release evidence to repo TODO/docs without credentials.
- [ ] User live Google consent is a separate runtime acceptance step: confirmed Gmail full and agent Vault, using OPSA. Keep personal profile outside public checkout. Ask user only for browser login/consent when necessary; report metadata only.
