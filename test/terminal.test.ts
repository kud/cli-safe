import { describe, expect, it } from "vitest"
import { isTTYSafe, sanitizeForTerminal } from "../src/index.js"

const ESC = "\x1B"
const BEL = "\x07"
const ST = `${ESC}\\`

// After sanitising, the only control characters left are newline and tab,
// plus whole SGR sequences when colour is kept.
const assertInert = (out: string, keepColour = false) => {
  const rest = keepColour ? out.replace(/\x1B\[[0-9;:]*m/g, "") : out
  expect(rest).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/)
}

describe("sanitizeForTerminal: ordinary text", () => {
  it("leaves plain text, tabs and newlines alone", () => {
    const text = "build #12\tpassed\nnext line\n"
    expect(sanitizeForTerminal(text)).toBe(text)
  })

  it("keeps non-ASCII text, including emoji and right-to-left scripts", () => {
    const text = "café — 日本語 — עברית — 🚀"
    expect(sanitizeForTerminal(text)).toBe(text)
  })

  it("decodes bytes as UTF-8", () => {
    expect(sanitizeForTerminal(new TextEncoder().encode("héllo\n"))).toBe("héllo\n")
    expect(sanitizeForTerminal(Buffer.from("ok"))).toBe("ok")
  })

  it("turns CRLF and lone CR into LF so nothing is overprinted", () => {
    expect(sanitizeForTerminal("a\r\nb\rc\r")).toBe("a\nb\nc\n")
    expect(sanitizeForTerminal("\r\r\n")).toBe("\n\n")
  })

  it("returns an empty string for empty input", () => {
    expect(sanitizeForTerminal("")).toBe("")
  })
})

describe("sanitizeForTerminal: escape sequences", () => {
  it("removes CSI sequences: colours, cursor movement, erase", () => {
    expect(sanitizeForTerminal(`${ESC}[31mred${ESC}[0m`)).toBe("red")
    expect(sanitizeForTerminal(`a${ESC}[2Ab${ESC}[2Kc${ESC}[?25l`)).toBe("abc")
    expect(sanitizeForTerminal(`${ESC}[1;2;3 q!`)).toBe("!")
  })

  it("removes OSC sequences ended by BEL or ST, including links and clipboard writes", () => {
    expect(sanitizeForTerminal(`${ESC}]0;title${BEL}text`)).toBe("text")
    expect(
      sanitizeForTerminal(`${ESC}]8;;https://example.com${ST}label${ESC}]8;;${ST}`),
    ).toBe("label")
    expect(sanitizeForTerminal(`x${ESC}]52;c;aGVsbG8=${BEL}y`)).toBe("xy")
  })

  it("removes DCS, SOS, PM and APC strings", () => {
    for (const intro of ["P", "X", "^", "_"])
      expect(sanitizeForTerminal(`a${ESC}${intro}payload${ST}b`)).toBe("ab")
  })

  it("removes the 8-bit (C1) forms of CSI, OSC, DCS, SOS, PM, APC and ST", () => {
    expect(sanitizeForTerminal("a\x9B31mb")).toBe("ab")
    expect(sanitizeForTerminal("a\x9D52;c;aGk=\x9Cb")).toBe("ab")
    expect(sanitizeForTerminal("a\x9D0;t\x07b")).toBe("ab")
    for (const intro of ["\x90", "\x98", "\x9E", "\x9F"])
      expect(sanitizeForTerminal(`a${intro}payload\x9Cb`)).toBe("ab")
  })

  it("removes two-byte and character-set escapes", () => {
    expect(sanitizeForTerminal(`a${ESC}7b${ESC}8c`)).toBe("abc")
    expect(sanitizeForTerminal(`${ESC}cclear`)).toBe("clear")
    expect(sanitizeForTerminal(`${ESC}(0lqk${ESC}(B`)).toBe("lqk")
    expect(sanitizeForTerminal(`${ESC}#8x`)).toBe("x")
    expect(sanitizeForTerminal(`${ESC}Mup`)).toBe("up")
  })

  it("removes a lone ESC and prints an unterminated string's payload as text", () => {
    expect(sanitizeForTerminal(`end${ESC}`)).toBe("end")
    expect(sanitizeForTerminal(`${ESC}]52;c;payload`)).toBe("52;c;payload")
    expect(sanitizeForTerminal("\x9D52;c;payload")).toBe("52;c;payload")
    expect(sanitizeForTerminal(`${ESC}[`)).toBe("")
  })

  it("does not let an escape hidden inside a control string survive", () => {
    const out = sanitizeForTerminal(`${ESC}]0;a${ESC}[31mb${BEL}c`)
    assertInert(out)
    expect(out).toBe("0;abc")
  })

  it("removes C0 controls other than tab and newline, DEL and C1 controls", () => {
    let all = ""
    for (let c = 0; c <= 0x9f; c++) all += String.fromCharCode(c)
    const out = sanitizeForTerminal(all)
    assertInert(out)
    // Printable ASCII, tab and newline (CR became a newline) remain.
    expect(out.replace(/[ -~]/g, "")).toBe("\t\n\n")
  })
})

describe("sanitizeForTerminal: keepColour", () => {
  it("keeps SGR sequences and removes everything else", () => {
    const text = `${ESC}[1;31mred${ESC}[0m ${ESC}[38;5;208mo${ESC}[m ${ESC}[38:2::1:2:3mx${ESC}[2Jy`
    expect(sanitizeForTerminal(text, { keepColour: true })).toBe(
      `${ESC}[1;31mred${ESC}[0m ${ESC}[38;5;208mo${ESC}[m ${ESC}[38:2::1:2:3mxy`,
    )
  })

  it("does not keep the 8-bit form of SGR, private SGR-like sequences or links", () => {
    const out = sanitizeForTerminal(
      `\x9B31ma${ESC}[?1mb${ESC}[>4;2mc${ESC}]8;;u${ST}d`,
      { keepColour: true },
    )
    expect(out).toBe("abcd")
  })

  it("cannot be fooled into assembling a sequence from removed pieces", () => {
    const out = sanitizeForTerminal(`${ESC}\x00[31m${ESC}${ESC}[2J`, {
      keepColour: true,
    })
    assertInert(out, true)
    expect(out).toBe("[31m")
  })

  it("strips colour by default", () => {
    expect(sanitizeForTerminal(`${ESC}[32mok${ESC}[0m`, { keepColour: false })).toBe("ok")
  })
})

describe("sanitizeForTerminal: hostile input", () => {
  const rand = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  it("never leaves a control character in random control-heavy input", () => {
    const next = rand(42)
    const alphabet = [ESC, "[", "]", "P", "\\", BEL, "\x9B", "\x9C", "\x9D", "\x90", "m", "1", ";", "\r", "\n", "\t", "\x00", "\x7F", "a", "("]
    for (let i = 0; i < 2000; i++) {
      let s = ""
      const len = Math.floor(next() * 40)
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(next() * alphabet.length)]
      assertInert(sanitizeForTerminal(s))
      const coloured = sanitizeForTerminal(s, { keepColour: true })
      assertInert(coloured, true)
      // What is kept is stable: sanitising again changes nothing.
      expect(sanitizeForTerminal(coloured, { keepColour: true })).toBe(coloured)
    }
  })

  it("stays fast on long unterminated sequences", () => {
    const cases = [
      "\x9D".repeat(200_000),
      `${ESC}]`.repeat(100_000),
      `${ESC}[${"1;".repeat(200_000)}`,
      `${ESC}]${"a".repeat(200_000)}`,
      `${ESC}${" ".repeat(200_000)}`,
    ]
    const started = performance.now()
    for (const c of cases) assertInert(sanitizeForTerminal(c))
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe("isTTYSafe", () => {
  it("is false for an interactive terminal", () => {
    expect(isTTYSafe({ isTTY: true })).toBe(false)
  })

  it("is true for files, pipes and missing streams", () => {
    expect(isTTYSafe({ isTTY: false })).toBe(true)
    expect(isTTYSafe({})).toBe(true)
    expect(isTTYSafe(undefined)).toBe(true)
    expect(isTTYSafe(null)).toBe(true)
  })
})
