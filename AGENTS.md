# Grantloom

Read the design and implementation plan in docs/superpowers before work.
Never print, commit or publish real client secrets, access/refresh tokens, authorization codes, 1Password service-account tokens or personal account configuration.
Use synthetic accounts and credentials in fixtures and documentation.
Follow TDD for authentication, persistence and protocol logic. Run focused tests while iterating, the full suite before committing. Keep TODO.md current.
Use the official OAuth/OIDC and MCP libraries; Node standard libraries for HTTP, files, subprocesses and tests. No hosted authentication service.
