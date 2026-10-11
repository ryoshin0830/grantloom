export const ERROR_MESSAGES = Object.freeze({
  FILE_STORE_UNSUPPORTED:
    "Local file storage is unsupported on Windows; use 1Password.",
  INVALID_CONFIG: "Configuration is invalid.",
  INVALID_CLIENT: "OAuth client configuration is invalid.",
  OP_FAILED: "1Password operation failed.",
  INVALID_RECORD: "Stored credential data is invalid.",
  STORE_UNSAFE: "Storage permissions or path are unsafe.",
  STORE_FAILED: "Credential storage failed.",
  STORE_NOT_FOUND: "No stored credentials were found.",
  STORE_CONFLICT:
    "Storage contains a different account, client, or scope selection.",
  STORE_AMBIGUOUS: "Multiple 1Password items match the destination.",
  STORE_MISMATCH: "Stored credentials failed readback verification.",
  SCOPES_INVALID: "Scope selection is invalid.",
  CLOUD_FAILED: "Enabled API listing is unavailable.",
  DISCOVERY_FAILED: "API scope discovery is unavailable.",
  OAUTH_FAILED: "Google authentication failed.",
  OAUTH_DENIED: "Google consent was denied.",
  TOKEN_INVALID: "Google token verification failed.",
  ACCOUNT_MISMATCH:
    "The verified Google account does not match the requested account.",
  SCOPES_MISSING: "The granted scopes do not include all requested scopes.",
  REFRESH_MISSING: "Google did not return a refresh token; repeat consent.",
  AUTH_CANCELLED: "Authentication was cancelled.",
  AUTH_EXPIRED: "Authentication session expired.",
  TOKEN_EXPIRED: "The access token has expired; refresh the profile.",
  INTERNAL_ERROR: "The operation failed.",
});
export class AppError extends Error {
  constructor(code, message) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL_ERROR);
    this.name = "AppError";
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : "INTERNAL_ERROR";
  }
}
export function publicError(error) {
  const code =
    error instanceof AppError && Object.hasOwn(ERROR_MESSAGES, error.code)
      ? error.code
      : "INTERNAL_ERROR";
  return { code, message: ERROR_MESSAGES[code] };
}
