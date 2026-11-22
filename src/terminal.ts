// Making untrusted text safe to print to a terminal.
//
// ⚠ TEXT FROM ELSEWHERE IS NOT JUST TEXT ONCE A TERMINAL READS IT. A build log,
// an API error message, a commit subject or a file name can carry escape
// sequences, and the terminal acts on them: it can be told to write to the
// clipboard (OSC 52), show a link that goes somewhere other than it says
// (OSC 8), move the cursor and rewrite lines already shown (CSI), change the
// window title, or switch character sets. A bare carriage return overprints a
// line with a different one. What is printed should be exactly what was in the
// text, so every one of these goes, in both its 7-bit (ESC-prefixed) and 8-bit
// (C1) spellings.

export interface SanitizeForTerminalOptions {
  /**
   * Keep SGR sequences (ESC [ … m: colour, bold, underline). Every other
   * escape sequence is still removed. Default false.
   */
  keepColour?: boolean
}

// One alternation, scanned once from left to right, so a sequence that is kept
// is never looked at again and nothing removed can be glued back into one.
//
// 1. Control strings: OSC (ESC ] / 0x9D), DCS (ESC P / 0x90), SOS (ESC X /
//    0x98), PM (ESC ^ / 0x9E) and APC (ESC _ / 0x9F), up to BEL or ST
//    (ESC \ / 0x9C). OSC carries hyperlinks, titles and clipboard writes.
//    The payload may not contain ESC or a C1 control, so every match attempt
//    stops at the next introducer and the scan stays linear on hostile input.
// 2. CSI (ESC [ / 0x9B): parameter bytes, intermediate bytes, final byte.
// 3. Any other escape: ESC, any intermediate bytes (0x20-0x2F), one final
//    byte (0x30-0x7E). Covers ESC 7 / ESC 8, ESC c, character-set switches
//    such as ESC ( 0, and ESC # 8. The introducer of a control string that is
//    never terminated is caught here too, so its payload prints as plain text
//    rather than being swallowed.
// 4. A single control character: C0 except tab and newline, DEL, C1, and a
//    lone ESC at the end of the text.
const UNSAFE =
  /(?:\x1B[\]PX^_]|[\x90\x98\x9D\x9E\x9F])[^\x07\x1B\x80-\x9F]*(?:\x07|\x1B\\|\x9C)|(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]|\x1B[ -/]*[0-~]|[\x00-\x08\x0B-\x1F\x7F-\x9F]/g

const SGR = /^\x1B\[[0-9;:]*m$/

const decoder = new TextDecoder()

/**
 * Make untrusted text safe to write to a terminal.
 *
 * Removes every escape sequence (CSI, OSC, DCS, SOS, PM, APC and two-byte
 * escapes, 7-bit and 8-bit), every C0 control except newline and tab, DEL and
 * every C1 control. CRLF becomes LF and a lone CR becomes LF, so nothing can be
 * overprinted. With `keepColour`, well-formed SGR sequences survive.
 *
 * Bytes are decoded as UTF-8; invalid sequences become U+FFFD.
 */
export const sanitizeForTerminal = (
  text: string | Uint8Array,
  options: SanitizeForTerminalOptions = {},
): string => {
  const s = typeof text === "string" ? text : decoder.decode(text)
  const keepColour = options.keepColour === true
  return s
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE, (m) => (keepColour && SGR.test(m) ? m : ""))
}

/** The part of a writable stream `isTTYSafe` looks at. */
export interface MaybeTTY {
  isTTY?: boolean
}

/**
 * Whether raw text can go to this stream without a terminal acting on it right
 * now: true for a file or a pipe, false for an interactive terminal.
 *
 * When it is false, pass untrusted text through `sanitizeForTerminal` first.
 * A file or pipe can still end up in a terminal later (`cat`, `less -R`), so
 * sanitising regardless is never wrong; this only tells you when it is not
 * optional.
 */
export const isTTYSafe = (stream: MaybeTTY | null | undefined): boolean =>
  stream?.isTTY !== true
