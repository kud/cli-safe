// Files that hold credentials: tokens, API keys, session cookies.
//
// ⚠ THE MODE MUST BE RIGHT FROM THE FIRST BYTE. A plain writeFileSync creates
// the file 0644 under the usual 022 umask, so the secret sits readable by every
// local account, and a chmod afterwards leaves a window in which it still is.
// The content goes to a temporary file opened 0600 in the same directory, is
// flushed to disk, then renamed over the target: a reader sees the old file or
// the new one, never half a token, and a file that was once world-readable is
// replaced by one that is not. Rename replaces a symbolic link at the target
// rather than writing through it.

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface WriteSecretFileOptions {
  /** Encoding for string data. Default "utf8". */
  encoding?: BufferEncoding
}

const isWindows = () => process.platform === "win32"

/**
 * Write a file only its owner can read, atomically.
 *
 * - Missing parent directories are created 0700. Directories that already
 *   existed are left as they are: the caller chose them.
 * - The data is written to a temporary file in the same directory, created
 *   0600 with O_EXCL, fsynced, then renamed over `file`.
 * - The result is 0600 whether or not `file` existed before.
 *
 * On Windows the modes are ignored by the file system; the write is still
 * atomic.
 */
export const writeSecretFile = (
  file: string,
  data: string | Uint8Array,
  options: WriteSecretFileOptions = {},
): void => {
  const target = path.resolve(file)
  const dir = path.dirname(target)

  const firstCreated = fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (firstCreated !== undefined) {
    // mkdir's mode is filtered by the umask; set it on every directory made.
    for (let d = dir; ; d = path.dirname(d)) {
      fs.chmodSync(d, 0o700)
      if (d === firstCreated) break
    }
  }

  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  )
  try {
    const fd = fs.openSync(tmp, "wx", 0o600)
    try {
      // The umask can only have narrowed 0600; make it exact.
      fs.fchmodSync(fd, 0o600)
      if (typeof data === "string")
        fs.writeFileSync(fd, data, { encoding: options.encoding ?? "utf8" })
      else fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  // The renamed file is already 0600; this also covers a file system that
  // did not honour the mode at creation.
  fs.chmodSync(target, 0o600)
  syncDirectory(dir)
}

// Make the rename itself durable. Not every platform lets a directory be
// opened or fsynced, and the file is already in place, so failure is ignored.
const syncDirectory = (dir: string): void => {
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, "r")
    fs.fsyncSync(fd)
  } catch {
    // best effort
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export interface ReadSecretFileOptions {
  /** Decode the contents with this encoding. `null` returns a Buffer. Default "utf8". */
  encoding?: BufferEncoding | null
  /**
   * What to do when group or others have any permission on the file:
   * "warn" emits a process warning (the default), "throw" refuses to return
   * the contents, "ignore" only reports it in the result.
   */
  onInsecureMode?: "warn" | "throw" | "ignore"
}

export interface SecretFileContents<T extends string | Buffer = string> {
  data: T
  /** Permission bits, e.g. 0o600. */
  mode: number
  /** True when group or others can do anything with the file (mode & 0o077). Always false on Windows. */
  insecureMode: boolean
}

/** Raised by `readSecretFile` with `onInsecureMode: "throw"`. */
export class InsecureFileModeError extends Error {
  code = "INSECURE_FILE_MODE" as const
  constructor(
    readonly file: string,
    readonly mode: number,
  ) {
    super(
      `${file} is mode ${formatMode(mode)}, readable beyond its owner; run chmod 600 on it`,
    )
    this.name = "InsecureFileModeError"
  }
}

const formatMode = (mode: number) => `0${mode.toString(8).padStart(3, "0")}`

/**
 * Read a secret file and report whether its mode is wider than 0600.
 *
 * The mode is taken from the open file descriptor, so it describes the file
 * whose bytes are returned even if the path is swapped meanwhile.
 */
export function readSecretFile(
  file: string,
  options?: ReadSecretFileOptions & { encoding?: BufferEncoding },
): SecretFileContents<string>
export function readSecretFile(
  file: string,
  options: ReadSecretFileOptions & { encoding: null },
): SecretFileContents<Buffer>
export function readSecretFile(
  file: string,
  options: ReadSecretFileOptions = {},
): SecretFileContents<string | Buffer> {
  const { encoding = "utf8", onInsecureMode = "warn" } = options
  const fd = fs.openSync(file, "r")
  try {
    const mode = fs.fstatSync(fd).mode & 0o777
    const insecureMode = !isWindows() && (mode & 0o077) !== 0
    if (insecureMode) {
      if (onInsecureMode === "throw") throw new InsecureFileModeError(file, mode)
      if (onInsecureMode === "warn")
        process.emitWarning(
          `${file} is mode ${formatMode(mode)}, readable beyond its owner; run chmod 600 on it`,
          { code: "INSECURE_FILE_MODE" },
        )
    }
    const raw = fs.readFileSync(fd)
    const data = encoding === null ? raw : raw.toString(encoding)
    return { data, mode, insecureMode }
  } finally {
    fs.closeSync(fd)
  }
}
