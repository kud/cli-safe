// URLs that carry credentials.
//
// ⚠ AN AUTHENTICATED CLIENT MUST NOT BE STEERABLE. Every request it makes
// carries a token, so whatever decides where a request goes decides who gets
// the token. A path segment that smuggles `/`, `..` or `?` turns "read item 7"
// into a request to any endpoint the account can reach; URL parsing collapses
// `..` before the request leaves, so encoding alone is not enough. A link or a
// redirect from the server can point at another host; a base URL can be plain
// HTTP, where anyone on the network reads the token.

import { UnsafeInputError } from "./errors.js"

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Origin, and nothing else, of a URL: safe to put in a message. */
const originOf = (url: URL): string =>
  url.origin === "null" ? `${url.protocol}…` : url.origin

const parse = (value: string | URL, what: string, base?: string | URL): URL => {
  if (value instanceof URL) return new URL(value.href)
  try {
    return new URL(value, base)
  } catch {
    throw new UnsafeInputError("INVALID_URL", `Invalid ${what}: not a URL`)
  }
}

/**
 * One path segment, percent-encoded, that cannot become more or less than one
 * segment.
 *
 * Refuses the empty string, `.` and `..`, and anything containing `/`, `\` or
 * NUL: those are mistakes or attempts to reach another path, and are better
 * refused than silently encoded. Numbers are accepted when finite.
 */
export const safePathSegment = (value: string | number): string => {
  let s: string
  if (typeof value === "number" && Number.isFinite(value)) s = String(value)
  else if (typeof value === "string") s = value
  else
    throw new UnsafeInputError(
      "UNSAFE_PATH_SEGMENT",
      `Invalid path segment ${show(value)}: expected a string`,
    )
  if (s === "" || s === "." || s === "..")
    throw new UnsafeInputError(
      "UNSAFE_PATH_SEGMENT",
      `Invalid path segment ${show(s)}: empty, "." and ".." are not allowed`,
    )
  if (/[/\\\0]/.test(s))
    throw new UnsafeInputError(
      "UNSAFE_PATH_SEGMENT",
      `Invalid path segment ${show(s)}: "/", "\\" and NUL are not allowed`,
    )
  try {
    return encodeURIComponent(s)
  } catch {
    throw new UnsafeInputError(
      "UNSAFE_PATH_SEGMENT",
      `Invalid path segment ${show(s)}: not well-formed Unicode`,
    )
  }
}

/**
 * Append path segments to a base, each through `safePathSegment`.
 *
 * `base` is an absolute URL (its query and fragment are kept) or a path that
 * starts with `/`. Exactly one `/` separates the base from the first segment.
 *
 *     joinUrlPath("https://ci.example.com/api/", "job", name, 7)
 *     // "https://ci.example.com/api/job/<name, encoded>/7"
 */
export const joinUrlPath = (
  base: string | URL,
  ...segments: Array<string | number>
): string => {
  const encoded = segments.map(safePathSegment)
  const join = (prefix: string) =>
    encoded.length === 0
      ? prefix
      : `${prefix.replace(/\/+$/, "")}/${encoded.join("/")}`
  const pathOnly =
    typeof base === "string" && base.startsWith("/") && !/^[/\\]{2}/.test(base)
  const url = pathOnly ? new URL(base, "http://path.invalid") : parse(base, "base URL")
  url.pathname = join(url.pathname)
  return pathOnly ? url.pathname + url.search + url.hash : url.href
}

/**
 * Resolve `url` against `base` and make sure it has the same origin (scheme,
 * host and port). Returns the resolved URL.
 *
 * Use it before following a link the server returned, so the credentials
 * attached for `base` are never sent elsewhere. An `https` base and an `http`
 * link are different origins, so a downgrade is refused too. URLs without an
 * origin (`file:`, `data:`) never match.
 */
export const assertSameOrigin = (url: string | URL, base: string | URL): URL => {
  const b = parse(base, "base URL")
  const u = parse(url, "URL", b)
  if (u.origin === "null" || u.origin !== b.origin)
    throw new UnsafeInputError(
      "CROSS_ORIGIN",
      `Refusing ${originOf(u)}: credentials are only sent to ${originOf(b)}`,
    )
  return u
}

const isLoopback = (hostname: string): boolean => {
  const h = hostname.toLowerCase()
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  )
}

export interface AssertSecureBaseUrlOptions {
  /** Allow `http:` for localhost, `*.localhost`, 127.0.0.0/8 and [::1]. Default false. */
  allowLocalhost?: boolean
  /**
   * "throw" (the default) raises on plain HTTP; "warn" emits a process
   * warning and carries on. Anything other than http or https always throws.
   */
  onInsecure?: "throw" | "warn"
}

/**
 * Check a base URL that credentials will be sent to: it must be `https:`,
 * or `http:` on a loopback host when `allowLocalhost` is set. Returns the
 * parsed URL. Messages name the origin only, never credentials or paths.
 */
export const assertSecureBaseUrl = (
  url: string | URL,
  options: AssertSecureBaseUrlOptions = {},
): URL => {
  const { allowLocalhost = false, onInsecure = "throw" } = options
  const u = parse(url, "base URL")
  if (u.protocol === "https:") return u
  if (u.protocol !== "http:")
    throw new UnsafeInputError(
      "INSECURE_URL",
      `Unsupported base URL scheme ${u.protocol}: expected https:`,
    )
  if (allowLocalhost && isLoopback(u.hostname)) return u
  const message = `${u.origin} is plain HTTP: credentials sent to it can be read on the network; use https:`
  if (onInsecure === "warn") {
    process.emitWarning(message, { code: "INSECURE_URL" })
    return u
  }
  throw new UnsafeInputError("INSECURE_URL", message)
}

/** Headers removed by default when a request moves to another origin. */
export const CREDENTIAL_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
]

export interface StripAuthOptions {
  /**
   * More header names to drop, e.g. "x-api-key" or "private-token". Fetch
   * already drops Authorization on a cross-origin redirect, but not these.
   */
  sensitiveHeaders?: readonly string[]
}

/**
 * The headers to send to `to`, given those sent to `from`: a copy, with
 * credential headers removed when the origin changes.
 */
export const stripAuthOnCrossOriginRedirect = (
  headers: ConstructorParameters<typeof Headers>[0],
  from: string | URL,
  to: string | URL,
  options: StripAuthOptions = {},
): Headers => {
  const out = new Headers(headers)
  const f = parse(from, "URL")
  const t = parse(to, "URL", f)
  if (f.origin === "null" || f.origin !== t.origin)
    for (const name of [...CREDENTIAL_HEADERS, ...(options.sensitiveHeaders ?? [])])
      out.delete(name)
  return out
}

export interface SafeFetchOptions extends StripAuthOptions {
  /** The fetch to use. Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Maximum redirects to follow. Default 5. */
  maxRedirects?: number
  /** Refuse any redirect to another origin instead of following it without credentials. Default false. */
  sameOriginOnly?: boolean
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * `fetch`, following redirects itself so credentials never leave the origin
 * they were meant for.
 *
 * - On a move to another origin, `Authorization`, `Proxy-Authorization`,
 *   `Cookie` and every `sensitiveHeaders` name are dropped (or, with
 *   `sameOriginOnly`, the redirect is refused).
 * - A redirect from `https:` to `http:` is refused.
 * - A 307 or 308 to another origin that would resend a request body is
 *   refused: the body may hold the credentials.
 * - 303, and 301/302 after a POST, continue as GET without a body, as
 *   browsers do.
 */
export const safeFetch = async (
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> => {
  const doFetch = options.fetch ?? globalThis.fetch
  const maxRedirects = options.maxRedirects ?? 5
  const start = parse(input, "URL")
  let url = start
  let method = (init.method ?? "GET").toUpperCase()
  let body = init.body
  let headers = new Headers(init.headers)

  for (let hop = 0; ; hop++) {
    const response = await doFetch(url, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    })
    const location = response.headers.get("location")
    if (!REDIRECTS.has(response.status) || location === null) return response

    await response.body?.cancel()
    if (hop >= maxRedirects)
      throw new UnsafeInputError(
        "TOO_MANY_REDIRECTS",
        `More than ${maxRedirects} redirects from ${originOf(start)}`,
      )

    const next = parse(location, "redirect location", url)
    const crossOrigin = next.origin === "null" || next.origin !== url.origin
    if (url.protocol === "https:" && next.protocol !== "https:")
      throw new UnsafeInputError(
        "INSECURE_REDIRECT",
        `Refusing redirect from ${originOf(url)} to ${originOf(next)}: not https`,
      )
    if (crossOrigin && options.sameOriginOnly)
      throw new UnsafeInputError(
        "CROSS_ORIGIN",
        `Refusing redirect from ${originOf(url)} to ${originOf(next)}`,
      )

    const status = response.status
    if (
      (status === 303 && method !== "HEAD") ||
      ((status === 301 || status === 302) && method === "POST")
    ) {
      method = "GET"
      body = undefined
      for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"])
        headers.delete(name)
    } else if (crossOrigin && body !== undefined && body !== null) {
      throw new UnsafeInputError(
        "CROSS_ORIGIN",
        `Refusing to resend a request body from ${originOf(url)} to ${originOf(next)}`,
      )
    }

    headers = stripAuthOnCrossOriginRedirect(headers, url, next, options)
    url = next
  }
}
