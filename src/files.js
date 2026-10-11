import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve, parse, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
export async function inspectPath(
  path,
  { directory = false, missing = false } = {},
) {
  if (process.platform === "win32")
    throw new AppError("FILE_STORE_UNSUPPORTED");
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (e) {
      if (e.code === "ENOENT" && missing) return false;
      throw new AppError("STORE_UNSAFE");
    }
    // macOS exposes its system temporary directories through these root-owned links.
    if (
      info.isSymbolicLink() &&
      !(
        process.platform === "darwin" &&
        ["/var", "/tmp"].includes(cursor) &&
        cursor !== absolute
      )
    )
      throw new AppError("STORE_UNSAFE");
    if (cursor === absolute) {
      if (directory ? !info.isDirectory() : !info.isFile())
        throw new AppError("STORE_UNSAFE");
      if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())
        throw new AppError("STORE_UNSAFE");
    } else if (!info.isDirectory() && !info.isSymbolicLink())
      throw new AppError("STORE_UNSAFE");
  }
  return true;
}
export async function prepareFile(path) {
  if (process.platform === "win32")
    throw new AppError("FILE_STORE_UNSUPPORTED");
  if (typeof path !== "string" || !path) throw new AppError("STORE_UNSAFE");
  const dir = dirname(resolve(path));
  await inspectPath(dir, { directory: true, missing: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await inspectPath(dir, { directory: true });
  await inspectPath(path, { missing: true });
}
export async function readPrivate(path) {
  if (
    !(await inspectPath(dirname(resolve(path)), {
      directory: true,
      missing: true,
    }))
  )
    throw new AppError("STORE_NOT_FOUND");
  if (!(await inspectPath(path, { missing: true })))
    throw new AppError("STORE_NOT_FOUND");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      (info.mode & 0o077) !== 0 ||
      !info.isFile() ||
      info.uid !== process.getuid()
    )
      throw new AppError("STORE_UNSAFE");
    return await handle.readFile("utf8");
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("STORE_FAILED");
  } finally {
    await handle?.close();
  }
}
export async function atomicWrite(path, text) {
  await prepareFile(path);
  const temporary = join(
    dirname(resolve(path)),
    `.grantloom-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = null;
    await inspectPath(path, { missing: true });
    await rename(temporary, path);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("STORE_FAILED");
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}

export async function withFileLock(path, operation) {
  await prepareFile(path);
  let handle;
  const lock = path + ".grantloom.lock";
  try {
    try {
      handle = await open(
        lock,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new AppError("STORE_FAILED");
    }
    return await operation();
  } finally {
    if (handle) {
      await handle.close();
      await unlink(lock).catch(() => {});
    }
  }
}
