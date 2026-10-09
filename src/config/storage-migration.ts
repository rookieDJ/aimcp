import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { normalizeUserConfig } from "./user-config.js";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";
import { ensurePrivateDirectory } from "../lib/fs/private-directory.js";

const MARKER = ".storage-migrated.json";
const TRANSIENT = new Set(["controller.json", "daemon.json", "controller.lock", "daemon.lock"]);

/** Copy private state once, keeping the original installation and data as a backup. */
export function migrateLegacyUserData(home = homedir()): boolean {
    const source = join(home, ".codex-mcp");
    const target = join(home, ".ai-mcp");
    if (!existsSync(source)) return false;
    assertOwned(source, true);
    // Do not migrate an empty installer prefix or recreate state from an installation backup.
    if (!readdirSync(source).some(name => !["npm", "bin"].includes(name))) return false;
    const lock = join(home, ".ai-mcp-migration.lock");
    let handle: number;
    try { handle = openSync(lock, "wx", 0o600); }
    catch { throw new Error("另一个迁移操作尚未结束；请检查 ~/.ai-mcp-migration.lock 后重试。"); }
    const lockIdentity = fstatSync(handle);
    const stage = join(home, `.ai-mcp-migration-${randomUUID()}`);
    const backup = join(home, `.ai-mcp-install-backup-${randomUUID()}`);
    let swapped = false;
    try {
        if (existsSync(target)) {
            assertOwned(target, true);
            if (existsSync(join(target, MARKER))) {
                assertOwned(join(target, MARKER), false);
                const marker = JSON.parse(readFileSync(join(target, MARKER), "utf8"));
                if (marker.schemaVersion === 1 && marker.source === source) return false;
                throw new Error("保存目录迁移标记无效；已保留新旧目录。");
            }
            if (readdirSync(target).some(name => name !== "npm" && name !== "bin")) {
                throw new Error("~/.ai-mcp 与 ~/.codex-mcp 同时包含数据，不能自动覆盖；请先备份并处理目录冲突。");
            }
        }
        for (const name of TRANSIENT) {
            const path = join(source, name);
            if (!existsSync(path)) continue;
            assertOwned(path, false);
            let state: { pid?: unknown };
            try { state = JSON.parse(readFileSync(path, "utf8")); }
            catch { throw new Error(`旧版 ${name} 无法验证，请先检查旧状态文件；迁移未修改数据。`); }
            if (typeof state.pid !== "number" || !Number.isInteger(state.pid) || state.pid <= 0) {
                throw new Error(`旧版 ${name} 的进程状态无效；迁移未修改数据。`);
            }
            if (alive(state.pid)) throw new Error("旧版 aimcp 仍在运行，请先运行 aimcp shutdown 完全关闭服务，再运行新版命令迁移。");
        }
        ensurePrivateDirectory(stage);
        // A freshly installed npm prefix may already occupy the target. Preserve it.
        if (existsSync(target)) for (const name of readdirSync(target)) {
            assertOwned(join(target, name), true);
            cpSync(join(target, name), join(stage, name), { recursive: true, dereference: false, verbatimSymlinks: true });
        }
        for (const name of readdirSync(source)) {
            if (name === "npm" || TRANSIENT.has(name)) continue;
            copyPrivate(join(source, name), join(stage, name), name === "bin");
        }
        const configPath = join(stage, "config.json");
        if (existsSync(configPath)) {
            let config;
            try {
                const raw = JSON.parse(readFileSync(configPath, "utf8"));
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid root");
                config = normalizeUserConfig(raw);
            }
            catch { throw new Error("旧版 config.json 无效或结构不受支持；请先备份并检查旧配置，原数据未迁移。"); }
            if (config.publicAccess?.kind === "cloudflare") {
                config.publicAccess.cloudflaredBin = rebase(config.publicAccess.cloudflaredBin, source, target);
            }
            writePrivateFileAtomic(configPath, `${JSON.stringify(config, null, 4)}\n`);
        }
        const yamlDir = join(stage, "tunnel-configs");
        if (existsSync(yamlDir)) for (const name of readdirSync(yamlDir)) {
            if (!/\.ya?ml$/.test(name)) continue;
            const path = join(yamlDir, name);
            const yaml = readFileSync(path, "utf8").replace(/^(\s*credentials-file:\s*)(.+)$/gm, (line, prefix: string, value: string) => {
                const trimmed = value.trim();
                const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : "";
                const original = quote ? (quote === '"' ? JSON.parse(trimmed) : trimmed.slice(1, -1).replaceAll("''", "'")) : trimmed;
                const rebased = rebase(original, source, target);
                return rebased === original ? line : `${prefix}${JSON.stringify(rebased)}`;
            });
            writePrivateFileAtomic(path, yaml);
        }
        writePrivateFileAtomic(join(stage, MARKER), JSON.stringify({ schemaVersion: 1, source }));
        if (existsSync(target)) { renameSync(target, backup); swapped = true; }
        try { renameSync(stage, target); }
        catch (error) { if (swapped) renameSync(backup, target); throw error; }
        if (swapped) {
            // Once committed, a backup cleanup failure must not report a failed migration.
            try { rmSync(backup, { recursive: true, force: true }); } catch { /* retained installation backup */ }
        }
        return true;
    } finally {
        rmSync(stage, { recursive: true, force: true });
        closeSync(handle);
        try {
            const current = lstatSync(lock);
            if (current.ino === lockIdentity.ino && current.dev === lockIdentity.dev) rmSync(lock);
        } catch { /* lock was already removed */ }
    }
}

function copyPrivate(source: string, target: string, executable = false): void {
    const stat = lstatSync(source);
    assertOwned(source, stat.isDirectory());
    if (stat.isDirectory()) {
        ensurePrivateDirectory(target);
        for (const name of readdirSync(source)) copyPrivate(join(source, name), join(target, name), executable);
    } else {
        // Prefer a tool from the freshly installed target over the legacy binary.
        if (executable && existsSync(target)) { assertOwned(target, false); return; }
        const mode = executable && (stat.mode & 0o111) ? 0o700 : 0o600;
        writePrivateFileAtomic(target, readFileSync(source));
        if (process.platform !== "win32") chmodSync(target, mode);
    }
}
function assertOwned(path: string, directory: boolean): void {
    const stat = lstatSync(path);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error(`迁移只允许当前用户拥有的真实目录和普通文件，不能使用链接：${path}`);
    }
}
function rebase(value: string, source: string, target: string): string {
    if (!isAbsolute(value)) return value;
    const suffix = relative(source, value);
    return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)) ? join(target, suffix) : value;
}
function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
