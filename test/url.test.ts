import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  CREDENTIAL_HEADERS,
  UnsafeInputError,
  assertSameOrigin,
  assertSecureBaseUrl,
  joinUrlPath,
  safeFetch,
  safePathSegment,
  stripAuthOnCrossOriginRedirect,
} from "../src/index.js"

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(UnsafeInputError)
    expect((e as Error).name).toBe("UnsafeInputError")
    return (e as UnsafeInputError).code
  }
  return undefined
}

const asyncCodeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(UnsafeInputError)
    return (e as UnsafeInputError).code
  }
  return undefined
}

describe("safePathSegment", () => {
  it("encodes ordinary values as one segment", () => {
    expect(safePathSegment("my job")).toBe("my%20job")
    expect(safePathSegment("a?b#c")).toBe("a%3Fb%23c")
    expect(safePathSegment("café")).toBe("caf%C3%A9")
    expect(safePathSegment("...")).toBe("...")
    expect(safePathSegment(".hidden")).toBe(".hidden")
    expect(safePathSegment(42)).toBe("42")
    expect(safePathSegment(0)).toBe("0")
  })

  it("encodes percent signs, so a pre-encoded dot segment stays literal", () => {
    expect(safePathSegment("%2e%2e")).toBe("%252e%252e")
    expect(safePathSegment("%2F")).toBe("%252F")
  })

  it("refuses empty, dot and dot-dot", () => {
    for (const v of ["", ".", ".."]) expect(codeOf(() => safePathSegment(v))).toBe("UNSAFE_PATH_SEGMENT")
  })

  it("refuses slashes, backslashes and NUL anywhere", () => {
    for (const v of ["a/b", "/", "../x", "a\\b", "\\", "a\0b"])
      expect(codeOf(() => safePathSegment(v))).toBe("UNSAFE_PATH_SEGMENT")
  })

  it("refuses non-strings and non-finite numbers", () => {
    for (const v of [NaN, Infinity, null, undefined, {}, ["a"]])
      expect(codeOf(() => safePathSegment(v as never))).toBe("UNSAFE_PATH_SEGMENT")
  })

  it("refuses ill-formed Unicode", () => {
    expect(codeOf(() => safePathSegment("\uD800"))).toBe("UNSAFE_PATH_SEGMENT")
  })

  it("names a value it cannot serialise without crashing", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(codeOf(() => safePathSegment(cyclic as never))).toBe("UNSAFE_PATH_SEGMENT")
    expect(codeOf(() => safePathSegment(Symbol("s") as never))).toBe("UNSAFE_PATH_SEGMENT")
  })
})

describe("joinUrlPath", () => {
  it("appends encoded segments to an absolute URL with exactly one slash", () => {
    expect(joinUrlPath("https://ci.example.com", "job", "a b", 7)).toBe(
      "https://ci.example.com/job/a%20b/7",
    )
    expect(joinUrlPath("https://ci.example.com/api//", "x")).toBe("https://ci.example.com/api/x")
    expect(joinUrlPath(new URL("https://h.example/base"), "x")).toBe("https://h.example/base/x")
  })

  it("keeps the base's query and fragment", () => {
    expect(joinUrlPath("https://h.example/api?v=2#top", "items", "1")).toBe(
      "https://h.example/api/items/1?v=2#top",
    )
  })

  it("works on a path", () => {
    expect(joinUrlPath("/api", "users", "me")).toBe("/api/users/me")
    expect(joinUrlPath("/", "x")).toBe("/x")
    expect(joinUrlPath("/api?q=1", "x")).toBe("/api/x?q=1")
  })

  it("returns the base unchanged without segments", () => {
    expect(joinUrlPath("https://h.example/api/")).toBe("https://h.example/api/")
    expect(joinUrlPath("/api/")).toBe("/api/")
  })

  it("cannot be walked out of the base", () => {
    expect(codeOf(() => joinUrlPath("https://h.example/api", ".."))).toBe("UNSAFE_PATH_SEGMENT")
    expect(codeOf(() => joinUrlPath("https://h.example/api", "../admin"))).toBe("UNSAFE_PATH_SEGMENT")
    expect(joinUrlPath("https://h.example/api", "%2e%2e")).toBe("https://h.example/api/%252e%252e")
    expect(joinUrlPath("https://h.example/api", "?admin=1")).toBe("https://h.example/api/%3Fadmin%3D1")
  })

  it("refuses a protocol-relative or unparseable base, without echoing it", () => {
    for (const base of ["//evil.example/x", "/\\evil.example", "not a url", "relative/path"]) {
      let message = ""
      try {
        joinUrlPath(base, "x")
      } catch (e) {
        expect((e as UnsafeInputError).code).toBe("INVALID_URL")
        message = (e as Error).message
      }
      expect(message).not.toContain("evil")
      expect(message).not.toBe("")
    }
  })
})

describe("assertSameOrigin", () => {
  const base = "https://api.example.com/v1/"

  it("accepts same-origin absolute and relative URLs and returns them resolved", () => {
    expect(assertSameOrigin("https://api.example.com/v1/next?page=2", base).href).toBe(
      "https://api.example.com/v1/next?page=2",
    )
    expect(assertSameOrigin("next", base).href).toBe("https://api.example.com/v1/next")
    expect(assertSameOrigin("HTTPS://API.EXAMPLE.COM:443/x", base).href).toBe(
      "https://api.example.com/x",
    )
    expect(assertSameOrigin(new URL("/y", base), new URL(base)).pathname).toBe("/y")
  })

  it("refuses another host, port or scheme", () => {
    for (const url of [
      "https://evil.example/",
      "//evil.example/",
      "https://api.example.com.evil.example/",
      "https://api.example.com:8443/",
      "http://api.example.com/",
      "https://user@evil.example/",
    ])
      expect(codeOf(() => assertSameOrigin(url, base))).toBe("CROSS_ORIGIN")
  })

  it("refuses URLs without an origin", () => {
    expect(codeOf(() => assertSameOrigin("file:///etc/hosts", "file:///etc/"))).toBe("CROSS_ORIGIN")
    expect(codeOf(() => assertSameOrigin("data:text/plain,x", base))).toBe("CROSS_ORIGIN")
  })

  it("never puts credentials, paths or queries in the message", () => {
    let message = ""
    try {
      assertSameOrigin("https://u:secretpw@evil.example/p?token=abc", "https://k:key@api.example.com/q")
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("https://evil.example")
    expect(message).not.toMatch(/secretpw|token|abc|key|\/p|\/q/)
  })

  it("refuses an invalid base", () => {
    expect(codeOf(() => assertSameOrigin("/x", "nope"))).toBe("INVALID_URL")
  })
})

describe("assertSecureBaseUrl", () => {
  it("accepts https and returns the parsed URL", () => {
    expect(assertSecureBaseUrl("https://ci.example.com/").host).toBe("ci.example.com")
  })

  it("refuses plain http by default, without echoing credentials", () => {
    let message = ""
    try {
      assertSecureBaseUrl("http://u:hunter2@ci.example.com/path")
    } catch (e) {
      expect((e as UnsafeInputError).code).toBe("INSECURE_URL")
      message = (e as Error).message
    }
    expect(message).toContain("http://ci.example.com")
    expect(message).not.toMatch(/hunter2|path/)
  })

  it("refuses localhost unless allowed", () => {
    expect(codeOf(() => assertSecureBaseUrl("http://localhost:8080"))).toBe("INSECURE_URL")
    for (const url of [
      "http://localhost:8080",
      "http://LOCALHOST",
      "http://app.localhost",
      "http://127.0.0.1:3000",
      "http://127.1.2.3",
      "http://[::1]:9000",
    ])
      expect(assertSecureBaseUrl(url, { allowLocalhost: true }).protocol).toBe("http:")
  })

  it("does not mistake look-alike hosts for loopback", () => {
    for (const url of ["http://localhost.evil.example", "http://127.0.0.1.evil.example", "http://0.0.0.0", "http://10.0.0.1"])
      expect(codeOf(() => assertSecureBaseUrl(url, { allowLocalhost: true }))).toBe("INSECURE_URL")
  })

  it("warns instead of throwing when asked to", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {})
    try {
      expect(assertSecureBaseUrl("http://ci.example.com", { onInsecure: "warn" }).protocol).toBe("http:")
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain HTTP"), { code: "INSECURE_URL" })
    } finally {
      warn.mockRestore()
    }
  })

  it("always refuses other schemes and invalid input", () => {
    expect(codeOf(() => assertSecureBaseUrl("ftp://ci.example.com", { onInsecure: "warn" }))).toBe("INSECURE_URL")
    expect(codeOf(() => assertSecureBaseUrl("javascript:alert(1)"))).toBe("INSECURE_URL")
    expect(codeOf(() => assertSecureBaseUrl("ci.example.com"))).toBe("INVALID_URL")
  })
})

describe("stripAuthOnCrossOriginRedirect", () => {
  const headers = {
    Authorization: "Bearer t",
    "Proxy-Authorization": "Basic p",
    Cookie: "s=1",
    "X-Api-Key": "k",
    Accept: "application/json",
  }

  it("keeps everything on the same origin", () => {
    const out = stripAuthOnCrossOriginRedirect(headers, "https://a.example/x", "/y")
    expect(out.get("authorization")).toBe("Bearer t")
    expect(out.get("x-api-key")).toBe("k")
  })

  it("drops credential headers and the listed ones on another origin", () => {
    const out = stripAuthOnCrossOriginRedirect(headers, "https://a.example/x", "https://b.example/", {
      sensitiveHeaders: ["X-API-KEY"],
    })
    for (const name of CREDENTIAL_HEADERS) expect(out.has(name)).toBe(false)
    expect(out.has("x-api-key")).toBe(false)
    expect(out.get("accept")).toBe("application/json")
  })

  it("treats a downgrade to http and an opaque origin as another origin", () => {
    expect(
      stripAuthOnCrossOriginRedirect(headers, "https://a.example/", "http://a.example/").has("authorization"),
    ).toBe(false)
    expect(
      stripAuthOnCrossOriginRedirect(headers, "file:///a", "file:///b").has("authorization"),
    ).toBe(false)
  })

  it("returns a copy and accepts no headers at all", () => {
    const input = new Headers(headers)
    stripAuthOnCrossOriginRedirect(input, "https://a.example/", "https://b.example/")
    expect(input.get("authorization")).toBe("Bearer t")
    expect([...stripAuthOnCrossOriginRedirect(undefined, "https://a.example/", "https://b.example/")]).toEqual([])
  })
})

describe("safeFetch against real servers", () => {
  type Seen = { path: string; method: string; headers: http.IncomingHttpHeaders; body: string }
  const seenA: Seen[] = []
  const seenB: Seen[] = []
  let a: http.Server
  let b: http.Server
  let originA = ""
  let originB = ""

  const listen = (seen: Seen[], route: (req: http.IncomingMessage, res: http.ServerResponse) => void) =>
    new Promise<http.Server>((resolve) => {
      const server = http.createServer((req, res) => {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          seen.push({ path: req.url!, method: req.method!, headers: req.headers, body })
          route(req, res)
        })
      })
      server.listen(0, "127.0.0.1", () => resolve(server))
    })

  beforeAll(async () => {
    b = await listen(seenB, (_req, res) => res.end("from b"))
    originB = `http://127.0.0.1:${(b.address() as AddressInfo).port}`
    a = await listen(seenA, (req, res) => {
      const to = (status: number, location: string) => {
        res.writeHead(status, { location })
        res.end("redirect body")
      }
      if (req.url === "/same") return to(302, "/final")
      if (req.url === "/cross") return to(302, `${originB}/landing`)
      if (req.url === "/post-303") return to(303, "/final")
      if (req.url === "/loop") return to(302, "/loop")
      res.end(`from a ${req.url}`)
    })
    originA = `http://127.0.0.1:${(a.address() as AddressInfo).port}`
  })

  afterAll(() => {
    a.close()
    b.close()
  })

  const auth = { Authorization: "Bearer secret", "X-Api-Key": "key", Cookie: "c=1" }

  it("keeps credentials on a same-origin redirect", async () => {
    const res = await safeFetch(`${originA}/same`, { headers: auth }, { sensitiveHeaders: ["x-api-key"] })
    expect(await res.text()).toBe("from a /final")
    const last = seenA.at(-1)!
    expect(last.path).toBe("/final")
    expect(last.headers.authorization).toBe("Bearer secret")
    expect(last.headers["x-api-key"]).toBe("key")
  })

  it("drops credentials, including custom ones, on a cross-origin redirect", async () => {
    const res = await safeFetch(`${originA}/cross`, { headers: auth }, { sensitiveHeaders: ["x-api-key"] })
    expect(await res.text()).toBe("from b")
    const last = seenB.at(-1)!
    expect(last.path).toBe("/landing")
    expect(last.headers.authorization).toBeUndefined()
    expect(last.headers["x-api-key"]).toBeUndefined()
    expect(last.headers.cookie).toBeUndefined()
  })

  it("refuses a cross-origin redirect with sameOriginOnly", async () => {
    expect(await asyncCodeOf(safeFetch(`${originA}/cross`, { headers: auth }, { sameOriginOnly: true }))).toBe(
      "CROSS_ORIGIN",
    )
  })

  it("turns a POST into a GET without a body on 303", async () => {
    const res = await safeFetch(`${originA}/post-303`, {
      method: "post",
      body: "token=secret",
      headers: { "content-type": "application/x-www-form-urlencoded", ...auth },
    })
    expect(res.status).toBe(200)
    const last = seenA.at(-1)!
    expect(last.method).toBe("GET")
    expect(last.body).toBe("")
    expect(last.headers["content-type"]).toBeUndefined()
  })

  it("stops after maxRedirects", async () => {
    expect(await asyncCodeOf(safeFetch(`${originA}/loop`, {}, { maxRedirects: 2 }))).toBe("TOO_MANY_REDIRECTS")
  })

  it("returns a response that is not a redirect as it is", async () => {
    const res = await safeFetch(new URL(`${originA}/plain`))
    expect(await res.text()).toBe("from a /plain")
  })
})

describe("safeFetch rules", () => {
  // A fake fetch answering from a table: url -> [status, location?].
  const fakeFetch = (table: Record<string, [number, string?]>) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const impl = (async (url: URL, init: RequestInit) => {
      calls.push({ url: url.href, init })
      const [status, location] = table[url.href] ?? [200]
      // 304 must not have a body; 308 goes without one to cover that case too.
      const body = status === 200 ? "ok" : status === 304 || status === 308 ? null : "moved"
      return new Response(body, {
        status,
        headers: location === undefined ? {} : { location },
      })
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it("refuses a redirect from https to http", async () => {
    const { impl } = fakeFetch({ "https://a.example/": [302, "http://a.example/"] })
    expect(await asyncCodeOf(safeFetch("https://a.example/", {}, { fetch: impl }))).toBe("INSECURE_REDIRECT")
  })

  it("refuses to resend a body to another origin on 307 and 308", async () => {
    for (const status of [307, 308]) {
      const { impl } = fakeFetch({ "https://a.example/": [status, "https://b.example/"] })
      expect(
        await asyncCodeOf(safeFetch("https://a.example/", { method: "PUT", body: "secret" }, { fetch: impl })),
      ).toBe("CROSS_ORIGIN")
    }
  })

  it("resends the body on a same-origin 307", async () => {
    const { impl, calls } = fakeFetch({ "https://a.example/": [307, "/again"] })
    await safeFetch("https://a.example/", { method: "PUT", body: "data" }, { fetch: impl })
    expect(calls[1]!.url).toBe("https://a.example/again")
    expect(calls[1]!.init.method).toBe("PUT")
    expect(calls[1]!.init.body).toBe("data")
    expect(calls[1]!.init.redirect).toBe("manual")
  })

  it("follows a cross-origin 307 without a body, minus credentials", async () => {
    const { impl, calls } = fakeFetch({ "https://a.example/": [307, "https://b.example/"] })
    await safeFetch("https://a.example/", { headers: { authorization: "t" } }, { fetch: impl })
    expect(new Headers(calls[1]!.init.headers).has("authorization")).toBe(false)
  })

  it("keeps HEAD on a 303 and POST on a 307", async () => {
    const head = fakeFetch({ "https://a.example/": [303, "/b"] })
    await safeFetch("https://a.example/", { method: "HEAD" }, { fetch: head.impl })
    expect(head.calls[1]!.init.method).toBe("HEAD")

    const post = fakeFetch({ "https://a.example/": [307, "/b"] })
    await safeFetch("https://a.example/", { method: "POST", body: "x" }, { fetch: post.impl })
    expect(post.calls[1]!.init.method).toBe("POST")
  })

  it("turns a POST into a GET on 301 and 302, but leaves PUT alone", async () => {
    for (const status of [301, 302]) {
      const { impl, calls } = fakeFetch({ "https://a.example/": [status, "/b"] })
      await safeFetch("https://a.example/", { method: "POST", body: "x" }, { fetch: impl })
      expect(calls[1]!.init.method).toBe("GET")
      expect(calls[1]!.init.body).toBeUndefined()
    }
    const put = fakeFetch({ "https://a.example/": [302, "/b"] })
    await safeFetch("https://a.example/", { method: "PUT", body: "x" }, { fetch: put.impl })
    expect(put.calls[1]!.init.method).toBe("PUT")
  })

  it("returns a 3xx without a Location, and a 304, as they are", async () => {
    const { impl } = fakeFetch({ "https://a.example/": [302], "https://a.example/nm": [304, "/x"] })
    expect((await safeFetch("https://a.example/", {}, { fetch: impl })).status).toBe(302)
    expect((await safeFetch("https://a.example/nm", {}, { fetch: impl })).status).toBe(304)
  })

  it("treats a redirect to an opaque origin as cross-origin", async () => {
    const { impl } = fakeFetch({ "https://a.example/": [302, "data:text/plain,x"] })
    expect(await asyncCodeOf(safeFetch("https://a.example/", {}, { fetch: impl, sameOriginOnly: true }))).toBe(
      "INSECURE_REDIRECT",
    )
    const plain = fakeFetch({ "http://a.example/": [302, "data:text/plain,x"] })
    expect(await asyncCodeOf(safeFetch("http://a.example/", {}, { fetch: plain.impl, sameOriginOnly: true }))).toBe(
      "CROSS_ORIGIN",
    )
  })

  it("follows up to maxRedirects and refuses an invalid start URL", async () => {
    const { impl } = fakeFetch({ "https://a.example/1": [302, "/2"], "https://a.example/2": [302, "/3"] })
    expect((await safeFetch("https://a.example/1", {}, { fetch: impl, maxRedirects: 2 })).status).toBe(200)
    expect(await asyncCodeOf(safeFetch("https://a.example/1", {}, { fetch: impl, maxRedirects: 1 }))).toBe(
      "TOO_MANY_REDIRECTS",
    )
    expect(await asyncCodeOf(safeFetch("nope"))).toBe("INVALID_URL")
  })
})
