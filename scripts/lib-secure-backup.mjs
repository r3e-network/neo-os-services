import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const directoryOpenFlags =
  fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0);

function isStrictlyInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathError(message, code = 'EINVAL') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function secureDirectory(directoryPath) {
  const initial = await fs.lstat(directoryPath);
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    throw pathError(`backup directory is not a real directory: ${directoryPath}`);
  }

  let handle;
  try {
    handle = await fs.open(directoryPath, directoryOpenFlags);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !isSameFile(initial, opened)) {
      throw pathError(`backup directory changed while being opened: ${directoryPath}`);
    }

    await handle.chmod(0o700);
    const secured = await handle.stat();
    if ((secured.mode & 0o777) !== 0o700) {
      throw pathError(`failed to set owner-only backup directory permissions: ${directoryPath}`);
    }

    const current = await fs.lstat(directoryPath);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !isSameFile(secured, current) ||
      (current.mode & 0o777) !== 0o700
    ) {
      throw pathError(`backup directory changed while being secured: ${directoryPath}`);
    }

    return await fs.realpath(directoryPath);
  } finally {
    if (handle) await handle.close();
  }
}

async function findCanonicalAnchor(backupBase) {
  let anchor = path.dirname(backupBase);
  while (true) {
    try {
      const stat = await fs.stat(anchor);
      if (!stat.isDirectory()) {
        throw pathError(`backup path anchor is not a directory: ${anchor}`);
      }
      return { path: anchor, realPath: await fs.realpath(anchor) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(anchor);
      if (parent === anchor) throw error;
      anchor = parent;
    }
  }
}

export async function createSecureBackupDir(backupDir, backupBase) {
  const absoluteBackupDir = path.resolve(backupDir);
  const absoluteBackupBase = path.resolve(backupBase);
  if (!isStrictlyInside(absoluteBackupBase, absoluteBackupDir)) {
    throw pathError(`backup directory escapes its backup base: ${absoluteBackupDir}`);
  }

  const anchor = await findCanonicalAnchor(absoluteBackupBase);
  if (!isStrictlyInside(anchor.path, absoluteBackupDir)) {
    throw pathError(`backup directory escapes its canonical anchor: ${absoluteBackupDir}`);
  }

  const segments = path.relative(anchor.path, absoluteBackupDir).split(path.sep);
  let currentPath = anchor.path;
  let expectedRealPath = anchor.realPath;

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    expectedRealPath = path.join(expectedRealPath, segments[index]);
    const isTimestampDir = index === segments.length - 1;

    try {
      await fs.mkdir(currentPath, { mode: 0o700 });
    } catch (error) {
      if (isTimestampDir || error?.code !== 'EEXIST') throw error;
    }

    const realPath = await secureDirectory(currentPath);
    if (realPath !== expectedRealPath || !isStrictlyInside(anchor.realPath, realPath)) {
      throw pathError(`backup directory escapes its canonical boundary: ${currentPath}`);
    }
  }

  return expectedRealPath;
}

async function removeCreatedFile(filePath, createdIdentity) {
  try {
    const current = await fs.lstat(filePath);
    if (current.isSymbolicLink() || !current.isFile()) return;
    if (createdIdentity && !isSameFile(createdIdentity, current)) return;
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

export async function writeSecureBackupFile(backupDir, fileName, content) {
  const absoluteBackupDir = path.resolve(backupDir);
  if (
    typeof fileName !== 'string' ||
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    path.basename(fileName) !== fileName
  ) {
    throw pathError(`backup output must be a direct child of the backup directory: ${fileName}`);
  }

  const destination = path.resolve(absoluteBackupDir, fileName);
  if (
    path.dirname(destination) !== absoluteBackupDir ||
    !isStrictlyInside(absoluteBackupDir, destination)
  ) {
    throw pathError(`backup output escapes its backup directory: ${destination}`);
  }

  const realBackupDir = await secureDirectory(absoluteBackupDir);
  const realParent = await fs.realpath(path.dirname(destination));
  const canonicalDestination = path.join(realBackupDir, fileName);
  if (
    realParent !== realBackupDir ||
    path.dirname(canonicalDestination) !== realBackupDir ||
    !isStrictlyInside(realBackupDir, canonicalDestination)
  ) {
    throw pathError(`backup output escapes its canonical backup directory: ${destination}`);
  }

  const existing = await fs.lstat(destination).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    throw pathError(`refusing to overwrite existing backup output: ${destination}`, 'EEXIST');
  }

  let handle;
  let created = false;
  let createdIdentity;
  try {
    handle = await fs.open(destination, 'wx', 0o600);
    created = true;
    createdIdentity = await handle.stat();
    if (!createdIdentity.isFile()) {
      throw pathError(`backup output is not a regular file: ${destination}`);
    }

    await handle.chmod(0o600);
    const secured = await handle.stat();
    if ((secured.mode & 0o777) !== 0o600) {
      throw pathError(`failed to set owner-only backup file permissions: ${destination}`);
    }

    await handle.writeFile(content, { encoding: 'utf8' });
    const written = await handle.stat();
    if (
      !written.isFile() ||
      !isSameFile(createdIdentity, written) ||
      (written.mode & 0o777) !== 0o600
    ) {
      throw pathError(`backup output changed while being written: ${destination}`);
    }

    await handle.close();
    handle = null;

    const current = await fs.lstat(destination);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !isSameFile(createdIdentity, current) ||
      (current.mode & 0o777) !== 0o600
    ) {
      throw pathError(`backup output changed before verification: ${destination}`);
    }

    return destination;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) {
      try {
        await removeCreatedFile(destination, createdIdentity);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `backup write and cleanup failed: ${destination}`
        );
      }
    }
    throw error;
  }
}
