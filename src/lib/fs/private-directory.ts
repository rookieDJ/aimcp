import { chmodSync, lstatSync, mkdirSync } from "node:fs";

/** Only tighten directories explicitly owned by this application's private state. */
export function ensurePrivateDirectory(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const state = lstatSync(path);
    if (!state.isDirectory() || state.isSymbolicLink() ||
        (process.getuid && state.uid !== process.getuid())) {
        throw new Error("私有目录必须是当前用户拥有的真实目录，不能使用符号链接。");
    }
    if (process.platform !== "win32") chmodSync(path, 0o700);
}
