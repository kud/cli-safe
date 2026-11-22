# Changelog

All notable changes to this project are documented here.

---

## 0.1.0 — Unreleased

### Highlights

- **Terminal-safe text.** `sanitizeForTerminal` removes every escape sequence and control character a terminal would act on, in 7-bit and 8-bit forms, with an option to keep colours; `isTTYSafe` tells an interactive terminal from a file or pipe.
- **Secret files.** `writeSecretFile` writes 0600 from the first byte, atomically, creating missing directories 0700; `readSecretFile` warns, throws or reports when a file is readable beyond its owner.
- **URL safety.** `safePathSegment` and `joinUrlPath` keep each value to exactly one path segment; `assertSameOrigin`, `assertSecureBaseUrl`, `stripAuthOnCrossOriginRedirect` and `safeFetch` keep credentials on the origin and scheme they were meant for.
- **Shell and AppleScript quoting.** `shellQuote`, `shellJoin` and `appleScriptString`, for the cases where an argument array is not an option.
