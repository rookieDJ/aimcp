import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { list } from "tar";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowedPath = /^(?:dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|css)|scripts\/install\.(?:sh|ps1)|package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/;
const privateArtifacts = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.git|\.codex|\.codex-mcp|conversations?|logs?|credentials?|secrets?)(?:\/|$)/i;
const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AIza[A-Za-z0-9_-]{35}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b/,
    /https?:\/\/[^\s/"'<>:]+:[^\s/"'<>@]+@/,
    /["'](?:TunnelSecret|client_secret|api_token|access_token|refresh_token)["']\s*:\s*["'][A-Za-z0-9_+/=-]{24,}["']/,
];

/** Errors identify files only: never echo a detected credential or chat snippet. */
export function validatePackageEntry(path, content, { type = "File", privateText = [] } = {}) {
    if (type !== "File" || !allowedPath.test(path) || privateArtifacts.test(path)) {
        throw new Error(`发布包包含不允许的文件：${path}`);
    }
    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
    if (secretPatterns.some(pattern => pattern.test(text)) || privateText.some(value => value && text.includes(value))) {
        throw new Error(`发布文件含疑似凭据或本机隐私：${path}`);
    }
    for (const match of text.matchAll(/\/(?:Users|home)\/([^/\s"'`<>]+)\//g)) {
        if (!["username", "user", "example", "your-user", "<user>"].includes(match[1])) {
            throw new Error(`发布文件含个人目录：${path}`);
        }
    }
}

export async function checkTarball(tarball) {
    const privateText = [homedir(), process.env.USERPROFILE].filter(value => value && value !== "/");
    let count = 0;
    let bytes = 0;
    let failure;
    await list({ file: tarball, onReadEntry(entry) {
        const chunks = [];
        let entryBytes = 0;
        entry.on("data", chunk => {
            entryBytes += chunk.length; bytes += chunk.length;
            if (entryBytes > 16 * 1024 * 1024 || bytes > 32 * 1024 * 1024) failure ??= new Error("安装包超过检查大小限制");
            if (!failure) chunks.push(chunk);
        });
        entry.on("end", () => {
            try {
                if (!entry.path.startsWith("package/")) throw new Error("安装包目录无效");
                validatePackageEntry(entry.path.slice(8), Buffer.concat(chunks), { type: entry.type, privateText });
                count++;
            } catch (error) { failure ??= error; }
        });
    } });
    if (failure) throw failure;
    if (!count) throw new Error("安装包为空");
    return count;
}

export function checkPublishFiles() {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const output = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root, encoding: "utf8", stdio: "pipe",
        shell: process.platform === "win32", timeout: 30_000,
    });
    const files = JSON.parse(output)[0]?.files;
    if (!Array.isArray(files) || !files.length) throw new Error("npm 发布文件清单无效");
    const privateText = [homedir(), process.env.USERPROFILE].filter(value => value && value !== "/");
    for (const file of files) {
        const path = join(root, file.path);
        const type = lstatSync(path).isFile() ? "File" : "SymbolicLink";
        validatePackageEntry(file.path, "", { type });
        validatePackageEntry(file.path, readFileSync(path), { privateText, type });
    }
    return files.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const count = process.argv[2] ? await checkTarball(resolve(process.argv[2])) : checkPublishFiles();
        // Lifecycle stdout is part of `npm pack --json`; diagnostics belong on stderr.
        console.error(`package_privacy=PASS files=${count}`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : "发布包检查失败");
        process.exitCode = 1;
    }
}
