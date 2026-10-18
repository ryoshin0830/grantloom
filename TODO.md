# Grantloom progress

- [x] Design approved; create public personal GitHub repository.
- [x] Task 1: client/profile/store/scope foundations, tests, task self-review.
- [x] Task 2: consent session, verification, refresh and tests; independent review approved.
- [x] Task 3: CLI, MCP, Skill, documentation, packaging and CI; independent review approved.
- [x] Whole-branch Ponytail Review approved; five findings fixed, no unresolved minors.
- [x] Local installed package smoke and secret-leak checks; 15 intended files, no credential/personal-reference matches in tracked files or history.
- [x] PR #1 created and merged to main; all five latest-head CI jobs passed.
- [x] npm login, publish, verify registry, published npx and MCP.

- [x] 2026-10-11: grantloom public repo created; design and task plan committed; feature branch started.
- [x] npm web login completed; npm whoami verified ryoshin0830.
- [x] Runtime acceptance: user Google account consent with a private profile outside public repo.
- [x] 2026-10-18: retain completed release/acceptance records, remove unrelated runtime log and ignore root logs directory.
- [x] 2026-10-18: rewrite the default English README and add Japanese/Simplified Chinese guides with matching examples, file/storage explanations and complete CLI/MCP references. Verified links, shell/JSON syntax, CLI flags, MCP tools/profile example, all three READMEs in the 17-file npm package, and 148 passing tests.
- [ ] 2026-10-18: [multilingual README PR #3](https://github.com/ryoshin0830/grantloom/pull/3) opened; independent subagent review found two documentation issues, both corrected in all three languages (Cloud token-file permissions/platform support and scope-listing wording). Awaiting re-review and final CI before merge.

## Release evidence

- [PR #1](https://github.com/ryoshin0830/grantloom/pull/1), merged 2026-10-11; merge commit `fe5dbd5`.
- [Release-head CI](https://github.com/ryoshin0830/grantloom/actions/runs/38136901847): Ubuntu/macOS Node 22 and 24, Windows profile Node 24; all successful.
- Merged main: 148 tests passed, no failures/cancellations/skips; syntax and diff checks passed.
- 2026-10-11: the initial publish attempt stopped when npm's additional security-key authentication session became invalid.
- 2026-10-12: the first retry failed with registry PUT `E404`; a fresh `npm whoami` returned `E401`, while registry ping succeeded. The user reauthenticated and completed npm's publish challenge.
- `grantloom@0.1.0` published successfully on 2026-10-12. The authenticated version-status endpoint reports `published`; public registry metadata returns `0.1.0` with `latest: 0.1.0`, the intended bin and repository. Tarball SHA-1 `f0f3fe52cfe3a3568f27184b2e75ff167ee113c1` matches the verified local package.
- Published `npx --yes grantloom@0.1.0 --help` and `--version` passed from an isolated temporary directory. Published stdio MCP startup, exact seven-tool listing and `scopes_list` passed through the official SDK client; no real authentication/profile was used.
- Live Google consent is separate from publication. No account-specific configuration or token values are included in this repository.
- 2026-10-17: live Gmail full-access consent completed. CLI reported `saved` after account/scope verification, refresh round-trip and storage readback; a separate profile-status check also returned `saved`. Client, profile and credentials remain outside the public checkout.
