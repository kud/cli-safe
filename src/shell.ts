// Quoting for the rare case where a command line has to be a string.
//
// ⚠ PREFER NOT TO BUILD ONE. execFile and spawn take the program and its
// arguments as an array and never start a shell, so nothing in an argument is
// ever interpreted. Quoting is for what cannot take an array: a command shown
// to the user to copy, a line written into a script, an `ssh host <command>`.

import { UnsafeInputError } from "./errors.js"

// Characters no POSIX shell, bash or zsh gives a meaning to anywhere in a word.
// `=` is left out (zsh expands a leading `=cmd`), as are `~`, `^`, `#` and `!`.
const PLAIN = /^[A-Za-z0-9_@%+:,./-]+$/

const refuseNul = (value: unknown, what: string): string => {
  if (typeof value !== "string")
    throw new UnsafeInputError("UNSAFE_SHELL_ARGUMENT", `${what} must be a string`)
  if (value.includes("\0"))
    throw new UnsafeInputError(
      "UNSAFE_SHELL_ARGUMENT",
      `${what} contains NUL, which no argument can hold`,
    )
  return value
}

/**
 * Quote one argument for a POSIX shell (sh, dash, bash, zsh), so the shell
 * passes it through as exactly one word, unchanged.
 *
 * Plain words are returned as they are; anything else is wrapped in single
 * quotes, with each `'` written as `'\''`. Newlines and every other byte are
 * literal inside single quotes. Not for cmd.exe or PowerShell.
 *
 * Quoting does not stop a value starting with `-` from being read as an
 * option by the program; put `--` before such arguments.
 */
export const shellQuote = (value: string): string => {
  const s = refuseNul(value, "Shell argument")
  if (s === "") return "''"
  if (PLAIN.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Quote every argument with `shellQuote` and join them with spaces. */
export const shellJoin = (argv: readonly string[]): string =>
  argv.map(shellQuote).join(" ")

/**
 * An AppleScript string literal holding `value`, quotes included.
 *
 * Backslash and double quote are escaped, and tab, newline and carriage return
 * are written as `\t`, `\n` and `\r`. Safer still is not to put data in the
 * script at all: pass it as an argument to `on run argv` through execFile
 * (see the README).
 */
export const appleScriptString = (value: string): string => {
  const s = refuseNul(value, "AppleScript string")
  const escaped = s.replace(/[\\"\t\n\r]/g, (c) =>
    c === "\t" ? "\\t" : c === "\n" ? "\\n" : c === "\r" ? "\\r" : `\\${c}`,
  )
  return `"${escaped}"`
}
