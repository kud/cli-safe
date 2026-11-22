<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![npm](https://img.shields.io/npm/v/@kud/cli-safe?style=flat-square&color=CB3837)
![MIT](https://img.shields.io/badge/licence-MIT-22C55E?style=flat-square)

**Small, dependency-free safety helpers for Node CLIs and MCP servers: terminal-safe text, secret files, URL path segments, shell quoting.**

[Why](#-why) • [Features](#-features) • [Quick Start](#-quick-start) • [API Reference](#-api-reference) • [Development](#-development)

</div>

## 🤔 Why

Every command-line tool that talks to a server ends up writing the same few guards, and each one is easy to get slightly wrong. This package holds them once, tested, so a tool can import them instead of repeating them. They prevent these classes of bug:

- **A terminal obeying text it was only meant to show.** A build log, an error message from an API or a commit subject can contain escape sequences. Printed raw, they can write to the clipboard, disguise where a link goes, move the cursor to rewrite lines already shown, or change the window title.
- **A secret file readable by everyone on the machine.** Writing a token with the defaults creates it world-readable, and fixing the mode afterwards leaves a moment when it is not. A crash halfway through a write can leave half a token behind.
- **A request steered to an endpoint it was not meant for.** A name containing `/`, `..` or `?` placed in a URL path can turn "read this item" into "call that admin endpoint", with the tool's own credentials attached.
- **Credentials sent to the wrong server.** Following a link or a redirect to another host, or a downgrade from HTTPS to HTTP, can hand an API token to whoever runs that host or watches the network. Fetch already drops `Authorization` on a cross-origin redirect, but not custom headers such as `X-Api-Key`.
- **Data read as code by a shell or by AppleScript.** A file name or a message pasted into a command line or a script can end the string it sits in and run something else.

There are no runtime dependencies, so adding it adds nothing else to your tree.

## 🌟 Features

- 🧼 **Terminal-safe text** — `sanitizeForTerminal` removes every escape sequence and control character in both 7-bit and 8-bit spellings, optionally keeping colours; `isTTYSafe` says when it is not optional
- 🔐 **Secret files** — `writeSecretFile` writes 0600 from the first byte, atomically, in 0700 directories; `readSecretFile` warns, throws or reports when a file is readable beyond its owner
- 🧭 **URL path segments** — `safePathSegment` and `joinUrlPath` refuse `.`, `..`, `/`, `\` and NUL and encode the rest, so one value is always one segment
- 🛂 **Origin checks** — `assertSameOrigin`, `assertSecureBaseUrl`, `stripAuthOnCrossOriginRedirect` and `safeFetch` keep credentials on the host and scheme they were meant for
- 🐚 **Quoting, when you must** — `shellQuote`, `shellJoin` and `appleScriptString`, checked against real `sh`, `bash`, `dash` and `zsh`
- 🪶 **Tiny** — no runtime dependencies, ESM with types, Node 22 or later

## 🚀 Quick Start

```sh
npm install @kud/cli-safe
```

```ts
import {
  assertSecureBaseUrl,
  isTTYSafe,
  joinUrlPath,
  safeFetch,
  sanitizeForTerminal,
  writeSecretFile,
} from "@kud/cli-safe"

const base = assertSecureBaseUrl(process.env.API_URL!, { allowLocalhost: true })
const url = joinUrlPath(base, "projects", projectName, "logs")

const res = await safeFetch(url, { headers: { "X-Api-Key": token } }, {
  sensitiveHeaders: ["x-api-key"],
})
const log = await res.text()

// Always sanitise; keep colours only when a terminal is reading.
process.stdout.write(sanitizeForTerminal(log, { keepColour: !isTTYSafe(process.stdout) }))

writeSecretFile(`${process.env.HOME}/.config/my-cli/token`, token)
```

## 📖 API Reference

### 🧼 Terminal

#### `sanitizeForTerminal(text, { keepColour? })`

Returns `text` (a string, or bytes decoded as UTF-8) with nothing a terminal would act on:

- CSI sequences (`ESC [`), including cursor movement and screen erasure
- OSC strings (`ESC ]`), including OSC 8 hyperlinks, OSC 52 clipboard writes and window titles
- DCS, SOS, PM and APC strings
- two-byte escapes and character-set switches (`ESC 7`, `ESC c`, `ESC ( 0`, …)
- C0 controls except newline and tab, DEL, and C1 controls (`\x80`–`\x9f`), which some terminals treat as 8-bit escapes
- a lone ESC

CRLF and a lone CR both become LF, so no line can be overprinted by another. A control string that is never terminated loses its introducer and its payload prints as plain text. With `keepColour: true`, well-formed SGR sequences (`ESC [ … m`: colour, bold, underline) are kept and everything else still goes; colours are cosmetic, but they can still make text hard to see.

#### `isTTYSafe(stream)`

`true` when raw text can go to `stream` without a terminal acting on it right now (a file or a pipe), `false` for an interactive terminal. When it is `false`, sanitise first. A file or pipe can still reach a terminal later (`cat`, `less -R`), so sanitising regardless is never wrong.

### 🔐 Secret files

#### `writeSecretFile(path, data, { encoding? })`

Writes `data` (a string, or bytes) so only its owner can read it:

1. Missing parent directories are created 0700, whatever the umask. Directories that already existed keep their mode.
2. The data goes to a temporary file in the same directory, created 0600 with `O_EXCL`, then fsynced.
3. The temporary file is renamed over `path`. Readers see the old file or the new one, never half of either. A symbolic link at `path` is replaced, not written through.
4. `path` is set to 0600, so a file that used to be world-readable is not any more.

On failure the temporary file is removed and the error rethrown. On Windows the modes are ignored by the file system; the write is still atomic.

#### `readSecretFile(path, { encoding?, onInsecureMode? })`

Returns `{ data, mode, insecureMode }`. `insecureMode` is `true` when group or others have any permission (`mode & 0o077`); it is always `false` on Windows. `onInsecureMode` decides what else happens:

| Value              | Behaviour                                                         |
| ------------------ | ----------------------------------------------------------------- |
| `"warn"` (default) | `process.emitWarning` with code `INSECURE_FILE_MODE`              |
| `"throw"`          | throws `InsecureFileModeError` (`file`, `mode`) and returns nothing |
| `"ignore"`         | reports it in the result only                                     |

`encoding` defaults to `"utf8"`; `null` returns a `Buffer`. The mode is read from the open descriptor, so it describes the bytes returned. Neither the warning nor the error ever contains the file's contents.

### 🧭 URLs

#### `safePathSegment(value)`

Returns `encodeURIComponent(value)` for a string or a finite number. Throws `UnsafeInputError` (`UNSAFE_PATH_SEGMENT`) for `""`, `"."`, `".."`, anything containing `/`, `\` or NUL, ill-formed Unicode and anything that is not a string or number. A `%` is encoded too, so `%2e%2e` stays four literal characters rather than becoming `..`.

#### `joinUrlPath(base, ...segments)`

Appends each segment through `safePathSegment`, with exactly one `/` after the base. `base` is an absolute URL (its query and fragment are kept) or a path starting with `/`.

```ts
joinUrlPath("https://ci.example.com/api/", "job", "my job", 7)
// "https://ci.example.com/api/job/my%20job/7"
```

#### `assertSameOrigin(url, base)`

Resolves `url` against `base` and returns it, or throws `UnsafeInputError` (`CROSS_ORIGIN`) when scheme, host or port differ. Use it before following a link the server sent back. `https` to `http` counts as a different origin, and URLs with no origin (`file:`, `data:`) never match.

#### `assertSecureBaseUrl(url, { allowLocalhost?, onInsecure? })`

Checks a base URL that credentials will be sent to and returns it parsed. `https:` passes. `http:` throws `INSECURE_URL`, or with `onInsecure: "warn"` emits a process warning instead; with `allowLocalhost: true` it passes for `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]`. Any other scheme always throws.

#### `stripAuthOnCrossOriginRedirect(headers, from, to, { sensitiveHeaders? })`

Returns a copy of `headers` for a request moving from `from` to `to`. When the origin changes, `Authorization`, `Proxy-Authorization`, `Cookie` (listed in `CREDENTIAL_HEADERS`) and every name in `sensitiveHeaders` are removed. Use it in your own redirect loop, or let `safeFetch` do it.

#### `safeFetch(url, init?, { fetch?, maxRedirects?, sensitiveHeaders?, sameOriginOnly? })`

`fetch` that follows redirects itself (`redirect: "manual"`), so credentials stay where they belong:

- on a move to another origin, credential headers and `sensitiveHeaders` are dropped, or with `sameOriginOnly` the redirect is refused (`CROSS_ORIGIN`)
- a redirect from `https:` to anything else is refused (`INSECURE_REDIRECT`)
- a 307 or 308 that would resend a request body to another origin is refused (`CROSS_ORIGIN`), since the body may hold credentials
- 303, and 301 or 302 after a POST, continue as GET without a body
- more than `maxRedirects` (default 5) throws `TOO_MANY_REDIRECTS`

#### Errors

Every refusal above is an `UnsafeInputError` with a `code`: `UNSAFE_PATH_SEGMENT`, `INVALID_URL`, `CROSS_ORIGIN`, `INSECURE_URL`, `INSECURE_REDIRECT`, `TOO_MANY_REDIRECTS` or `UNSAFE_SHELL_ARGUMENT`. Messages name origins only, never credentials, paths or query strings.

### 🐚 Shell and AppleScript

Prefer `execFile` or `spawn` with an argument array to any quoting: they never start a shell, so nothing in an argument is interpreted.

```ts
import { execFile } from "node:child_process"

execFile("git", ["log", "--format=%s", "--", userPath])
```

Quoting is for what cannot take an array: a command shown to the user to copy, a line written into a script, a command run over `ssh`.

#### `shellQuote(value)` and `shellJoin(argv)`

`shellQuote` returns `value` as one word for a POSIX shell (`sh`, `dash`, `bash`, `zsh`): plain words unchanged, anything else in single quotes with each `'` written as `'\''`. `shellJoin` quotes each argument and joins them with spaces. NUL cannot be in an argument and throws `UNSAFE_SHELL_ARGUMENT`. Not for `cmd.exe` or PowerShell. Quoting does not stop a value that starts with `-` from being read as an option; put `--` before such arguments.

```ts
shellJoin(["git", "commit", "-m", "it's done"])
// git commit -m 'it'\''s done'
```

#### `appleScriptString(value)`

An AppleScript string literal, quotes included, with `\` and `"` escaped and tab, newline and carriage return written as `\t`, `\n` and `\r`. Better still is to keep data out of the script and hand it to `on run argv`:

```ts
execFile("osascript", [
  "-e", "on run argv",
  "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
  "-e", "end run",
  message,
  title,
])
```

## 🛠 Development

```sh
npm install
npm run typecheck
npm test
npm run test:coverage
npm run build
```

## Licence

MIT
