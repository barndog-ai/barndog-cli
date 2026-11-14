/** HTTP response status codes registered by IANA (RFC 9110). */
export const HTTP_STATUS = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  payloadTooLarge: 413,
  internalServerError: 500,
};

/** POSIX permission bits: execute for any user, group/other access, and creation modes. */
export const POSIX_MODE = {
  executableBits: 0o111,
  groupAndOtherBits: 0o077,
  privateDirectory: 0o700,
  executableFile: 0o755,
  regularFile: 0o644,
};

/** JavaScript timers and Date use milliseconds; Git and OAuth timestamps use seconds. */
export const MILLISECONDS_PER_SECOND = 1000;

/** Date timestamps expressed as one minute in milliseconds. */
export const MILLISECONDS_PER_MINUTE = 60000;

/** Time conversion for human-readable ages. */
export const MINUTES_PER_HOUR = 60;

/** Time conversion for human-readable ages. */
export const HOURS_PER_DAY = 24;

/** Git conventional abbreviated object ID length used in CLI labels. */
export const SHORT_COMMIT_LENGTH = 7;

/** BarnDog asset slug and local-name limit, shared with the API contract. */
export const MAX_ASSET_NAME_LENGTH = 64;

/** Hexadecimal encoding uses sixteen digits. */
export const HEX_RADIX = 16;
