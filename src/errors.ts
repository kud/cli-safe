/** What an `UnsafeInputError` refused. */
export type UnsafeInputCode =
  | "UNSAFE_PATH_SEGMENT"
  | "INVALID_URL"
  | "CROSS_ORIGIN"
  | "INSECURE_URL"
  | "INSECURE_REDIRECT"
  | "TOO_MANY_REDIRECTS"
  | "UNSAFE_SHELL_ARGUMENT"

/**
 * Raised when an input would not be used the way the caller meant: a path
 * segment that walks elsewhere, a URL on another origin or over plain HTTP, a
 * shell argument that cannot be represented. Messages never contain
 * credentials, URL paths or queries.
 */
export class UnsafeInputError extends Error {
  constructor(
    readonly code: UnsafeInputCode,
    message: string,
  ) {
    super(message)
    this.name = "UnsafeInputError"
  }
}
