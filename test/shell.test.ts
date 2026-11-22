import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { UnsafeInputError, appleScriptString, shellJoin, shellQuote } from "../src/index.js"

// Each argument quoted, run through a real shell, must come back unchanged.
const roundTrip = (shell: string, args: string[]): string[] => {
  const out = execFileSync(shell, ["-c", `printf '%s\\0' ${shellJoin(args)}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/nonexistent" },
  })
  return out.split("\0").slice(0, -1)
}

const hasShell = (name: string) => {
  try {
    execFileSync(name, ["-c", "true"])
    return true
  } catch {
    return false
  }
}

const tricky = [
  "plain",
  "with space",
  "it's",
  "''",
  "\"double\"",
  "$HOME",
  "${HOME}",
  "$(echo hi)",
  "`echo hi`",
  "a;b",
  "a&&b",
  "a|b",
  "a>b",
  "*",
  "?",
  "[ab]",
  "~",
  "~root",
  "=ls",
  "!!",
  "#comment",
  "back\\slash",
  "new\nline",
  "tab\tchar",
  "-n",
  "--flag=value",
  "unicodé ✓",
  "\x1B[31mred",
  "{a,b}",
  "^x",
]

describe("shellQuote", () => {
  it("leaves plain words as they are", () => {
    for (const w of ["abc", "a-b_c.d/e", "user@host:path", "a+b,c", "100%", "/usr/bin/env"])
      expect(shellQuote(w)).toBe(w)
  })

  it("single-quotes everything else, writing ' as '\\''", () => {
    expect(shellQuote("")).toBe("''")
    expect(shellQuote("a b")).toBe("'a b'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote("$(x)")).toBe("'$(x)'")
    expect(shellQuote("=ls")).toBe("'=ls'")
    expect(shellQuote("~")).toBe("'~'")
  })

  it("refuses NUL and non-strings", () => {
    for (const v of ["a\0b", 1, null, undefined]) {
      let code = ""
      try {
        shellQuote(v as string)
      } catch (e) {
        expect(e).toBeInstanceOf(UnsafeInputError)
        code = (e as UnsafeInputError).code
      }
      expect(code).toBe("UNSAFE_SHELL_ARGUMENT")
    }
  })
})

describe("shellJoin", () => {
  it("joins quoted arguments with spaces", () => {
    expect(shellJoin(["git", "commit", "-m", "it's done"])).toBe("git commit -m 'it'\\''s done'")
    expect(shellJoin([])).toBe("")
  })

  for (const shell of ["sh", "bash", "dash", "zsh"])
    it.runIf(hasShell(shell))(`round-trips hostile arguments through ${shell}`, () => {
      expect(roundTrip(shell, tricky)).toEqual(tricky)
      expect(roundTrip(shell, [""])).toEqual([""])
    })
})

describe("appleScriptString", () => {
  it("quotes and escapes backslash, quote, tab, newline and carriage return", () => {
    expect(appleScriptString("plain")).toBe('"plain"')
    expect(appleScriptString("")).toBe('""')
    expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""')
    expect(appleScriptString("C:\\path")).toBe('"C:\\\\path"')
    expect(appleScriptString("a\tb\nc\rd")).toBe('"a\\tb\\nc\\rd"')
  })

  it("cannot be closed early", () => {
    const hostile = '" & (do shell script "x") & "'
    const lit = appleScriptString(hostile)
    // Every quote inside the literal is escaped, so only the outer two are live.
    const inner = lit.slice(1, -1)
    expect(inner.replace(/\\./g, "")).not.toContain('"')
    expect(lit.startsWith('"') && lit.endsWith('"')).toBe(true)
  })

  it("refuses NUL", () => {
    let code = ""
    try {
      appleScriptString("a\0")
    } catch (e) {
      code = (e as UnsafeInputError).code
    }
    expect(code).toBe("UNSAFE_SHELL_ARGUMENT")
  })
})
