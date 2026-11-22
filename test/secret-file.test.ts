import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  InsecureFileModeError,
  readSecretFile,
  writeSecretFile,
} from "../src/index.js"

const posix = process.platform !== "win32"
const mode = (p: string) => fs.statSync(p).mode & 0o777

let root: string
let oldUmask: number

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-safe-"))
  oldUmask = process.umask(0o022)
})

afterEach(() => {
  process.umask(oldUmask)
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe.runIf(posix)("writeSecretFile", () => {
  it("writes 0600 in new 0700 directories under a 022 umask", () => {
    const file = path.join(root, "a", "b", "token.json")
    writeSecretFile(file, '{"token":"t"}')
    expect(fs.readFileSync(file, "utf8")).toBe('{"token":"t"}')
    expect(mode(file)).toBe(0o600)
    expect(mode(path.join(root, "a"))).toBe(0o700)
    expect(mode(path.join(root, "a", "b"))).toBe(0o700)
    // No temporary file is left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["token.json"])
  })

  it("sets 0700 even when the umask would narrow it", () => {
    process.umask(0o277)
    const file = path.join(root, "narrow", "secret")
    writeSecretFile(file, "s")
    expect(mode(path.dirname(file))).toBe(0o700)
    expect(mode(file)).toBe(0o600)
  })

  it("leaves an existing directory's mode alone", () => {
    fs.chmodSync(root, 0o755)
    const file = path.join(root, "secret")
    writeSecretFile(file, "s")
    expect(mode(root)).toBe(0o755)
    expect(mode(file)).toBe(0o600)
  })

  it("replaces an existing world-readable file with a 0600 one", () => {
    const file = path.join(root, "config.json")
    fs.writeFileSync(file, "old", { mode: 0o644 })
    expect(mode(file)).toBe(0o644)
    writeSecretFile(file, "new")
    expect(fs.readFileSync(file, "utf8")).toBe("new")
    expect(mode(file)).toBe(0o600)
  })

  it("replaces a symbolic link at the target instead of writing through it", () => {
    const elsewhere = path.join(root, "elsewhere")
    fs.writeFileSync(elsewhere, "untouched", { mode: 0o644 })
    const file = path.join(root, "link")
    fs.symlinkSync(elsewhere, file)
    writeSecretFile(file, "secret")
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched")
    expect(fs.readFileSync(file, "utf8")).toBe("secret")
  })

  it("writes bytes and honours a string encoding", () => {
    const bin = path.join(root, "bin")
    writeSecretFile(bin, new Uint8Array([0, 1, 255]))
    expect([...fs.readFileSync(bin)]).toEqual([0, 1, 255])

    const hex = path.join(root, "hex")
    writeSecretFile(hex, "cafe", { encoding: "hex" })
    expect([...fs.readFileSync(hex)]).toEqual([0xca, 0xfe])
  })

  it("resolves a relative path", () => {
    const cwd = process.cwd()
    process.chdir(root)
    try {
      writeSecretFile("relative.txt", "r")
    } finally {
      process.chdir(cwd)
    }
    expect(fs.readFileSync(path.join(root, "relative.txt"), "utf8")).toBe("r")
  })

  it("removes the temporary file and rethrows when the rename fails", () => {
    const file = path.join(root, "occupied")
    fs.mkdirSync(file)
    fs.writeFileSync(path.join(file, "child"), "x")
    expect(() => writeSecretFile(file, "s")).toThrow()
    expect(fs.readdirSync(root)).toEqual(["occupied"])
  })

  it("still succeeds when the directory cannot be fsynced", () => {
    const real = fs.fsyncSync
    let calls = 0
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      calls++
      // The first fsync is the file's own; fail only the directory's.
      if (calls > 1) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" })
      real(fd)
    })
    const file = path.join(root, "nosync")
    writeSecretFile(file, "s")
    expect(fs.readFileSync(file, "utf8")).toBe("s")
    expect(calls).toBe(2)
  })

  it("still succeeds when the directory cannot be opened", () => {
    const real = fs.openSync
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags: fs.OpenMode, m?: fs.Mode) => {
      if (flags === "r") throw Object.assign(new Error("EISDIR"), { code: "EISDIR" })
      return real(p, flags, m)
    }) as typeof fs.openSync)
    const file = path.join(root, "noopen")
    writeSecretFile(file, "s")
    expect(fs.readFileSync(file, "utf8")).toBe("s")
  })
})

describe.runIf(posix)("readSecretFile", () => {
  it("reads a 0600 file without a warning", () => {
    const file = path.join(root, "ok")
    writeSecretFile(file, "secret")
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {})
    expect(readSecretFile(file)).toEqual({ data: "secret", mode: 0o600, insecureMode: false })
    expect(warn).not.toHaveBeenCalled()
  })

  it("treats an owner-only 0400 or 0700 file as fine", () => {
    const file = path.join(root, "ro")
    writeSecretFile(file, "s")
    fs.chmodSync(file, 0o400)
    expect(readSecretFile(file).insecureMode).toBe(false)
    fs.chmodSync(file, 0o700)
    expect(readSecretFile(file).insecureMode).toBe(false)
  })

  it("warns about a group- or world-readable file by default, naming neither the contents", () => {
    const file = path.join(root, "loose")
    fs.writeFileSync(file, "hunter2", { mode: 0o644 })
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {})
    const result = readSecretFile(file)
    expect(result).toEqual({ data: "hunter2", mode: 0o644, insecureMode: true })
    expect(warn).toHaveBeenCalledOnce()
    const [message, opts] = warn.mock.calls[0]!
    expect(message).toContain("0644")
    expect(message).not.toContain("hunter2")
    expect(opts).toEqual({ code: "INSECURE_FILE_MODE" })
  })

  it("throws InsecureFileModeError when asked to", () => {
    const file = path.join(root, "loose")
    fs.writeFileSync(file, "s", { mode: 0o640 })
    let caught: unknown
    try {
      readSecretFile(file, { onInsecureMode: "throw" })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InsecureFileModeError)
    const err = caught as InsecureFileModeError
    expect(err.code).toBe("INSECURE_FILE_MODE")
    expect(err.mode).toBe(0o640)
    expect(err.file).toBe(file)
    expect(err.message).toContain("0640")
    expect(err.name).toBe("InsecureFileModeError")
  })

  it("only reports it when told to ignore", () => {
    const file = path.join(root, "loose")
    fs.writeFileSync(file, "s", { mode: 0o604 })
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {})
    expect(readSecretFile(file, { onInsecureMode: "ignore" }).insecureMode).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it("returns a Buffer with encoding null, and decodes other encodings", () => {
    const file = path.join(root, "bytes")
    writeSecretFile(file, new Uint8Array([0xca, 0xfe]))
    const raw = readSecretFile(file, { encoding: null })
    expect(Buffer.isBuffer(raw.data)).toBe(true)
    expect([...raw.data]).toEqual([0xca, 0xfe])
    expect(readSecretFile(file, { encoding: "hex" }).data).toBe("cafe")
  })

  it("throws the file system error for a missing file", () => {
    expect(() => readSecretFile(path.join(root, "missing"))).toThrow(/ENOENT/)
  })
})

describe("readSecretFile on Windows", () => {
  it("never reports an insecure mode, since modes mean nothing there", () => {
    const file = path.join(root, "win")
    fs.writeFileSync(file, "s", { mode: 0o666 })
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      expect(readSecretFile(file).insecureMode).toBe(false)
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })
})
