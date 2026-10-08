import {
    closeSync,
    constants,
    existsSync,
    fsyncSync,
    fchmodSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

function isWindowsReplaceError(error: unknown): boolean {
    if (!(error instanceof Error) || !("code" in error)) return false;
    return ["EACCES", "EEXIST", "EPERM"].includes(String(error.code));
}

function replaceFile(tempPath: string, path: string): void {
    try {
        renameSync(tempPath, path);
        return;
    } catch (error) {
        if (process.platform !== "win32" || !existsSync(path) || !isWindowsReplaceError(error)) {
            throw error;
        }
    }

    // Some Windows filesystems refuse rename-over-existing even though the native
    // operation normally replaces atomically. Preserve the prior file so this
    // compatibility path can roll back instead of deleting it first.
    const backupPath = `${path}.${process.pid}.${randomUUID()}.bak`;
    renameSync(path, backupPath);
    try {
        renameSync(tempPath, path);
    } catch (replaceError) {
        try {
            renameSync(backupPath, path);
        } catch (restoreError) {
            throw new AggregateError(
                [replaceError, restoreError],
                `Failed to replace and restore private file: ${path}`,
            );
        }
        throw replaceError;
    }
    try {
        rmSync(backupPath, { force: true });
    } catch {
        // The replacement is already committed. Never report it as failed or
        // let callers compensate state that now correctly points at the new file.
    }
}

/** Atomically replace a user-private file with a fully written 0600 temp file. */
export function writePrivateFileAtomic(path: string, content: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: number | undefined;
    try {
        handle = openSync(tempPath, "wx", 0o600);
        writeFileSync(handle, content);
        fsyncSync(handle);
        closeSync(handle);
        handle = undefined;
        replaceFile(tempPath, path);
    } finally {
        if (handle !== undefined) closeSync(handle);
        rmSync(tempPath, { force: true });
    }
}

/** Copy a credential without ever exposing a partially written destination. */
export function copyPrivateFileAtomic(source: string, destination: string): void {
    const content = readFileSync(source);
    writePrivateFileAtomic(destination, content);
}

/** Append logs without following a planted symlink or retaining old public modes. */
export function openPrivateAppendFile(path: string): number {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        const file = fstatSync(fd);
        if (!file.isFile() || (process.getuid && file.uid !== process.getuid())) throw new Error("私有日志必须是当前用户拥有的普通文件。");
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        return fd;
    } catch (error) { closeSync(fd); throw error; }
}
