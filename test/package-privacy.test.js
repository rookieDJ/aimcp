import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkPublishFiles, checkTarball, validatePackageEntry } from "../scripts/check-package.mjs";
import { create } from "tar";

test("publish guard excludes local data, credentials, personal paths and symlinks without echoing secrets", () => {
    for (const path of [".npmrc", ".env", ".codex-mcp/auth.json", "dist/conversations/chat.js", "dist/logs/a.js", "dist/settings.json", "dist/a.js.map", "dist/../private.js"]) {
        assert.throws(() => validatePackageEntry(path, "fixture"), /不允许的文件/);
    }
    const secret = "npm_" + "A".repeat(36);
    for (const content of [secret, "/Users/private-fixture/Projects", "/home/private-fixture/project", "-----BEGIN PRIVATE KEY-----", "https://fixture:password@example.com"]) {
        assert.throws(() => validatePackageEntry("dist/cli.js", content), error => !error.message.includes(content) && /隐私|个人目录/.test(error.message));
    }
    assert.throws(() => validatePackageEntry("dist/cli.js", "fixture", { type: "SymbolicLink" }), /不允许/);
    assert.doesNotThrow(() => validatePackageEntry("dist/cli.js", 'const path = "/Users/username/Projects/my-app";'));
    assert.ok(checkPublishFiles() > 0);
});

test("actual npm tarball excludes planted private data in root, caches and build directories", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "aimcp-pack-privacy-"));
    try {
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "aimcp-privacy-fixture", version: "1.0.0", files: ["dist/**/*.js", "dist/**/*.css", "README.md"] }));
        for (const dir of ["dist", ".codex", ".codex-mcp/conversations"]) mkdirSync(join(scratch, dir), { recursive: true });
        for (const file of [".env", ".npmrc", ".codex/cache.json", ".codex-mcp/auth.json", ".codex-mcp/conversations/chat.json", "dist/config.json", "dist/chat.json", "dist/cli.js.map"]) writeFileSync(join(scratch, file), "PRIVATE_FIXTURE");
        writeFileSync(join(scratch, "dist/cli.js"), "export const publicCode = true;");
        const npm = process.platform === "win32" ? "npm.cmd" : "npm";
        const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--ignore-scripts"], { cwd: scratch, encoding: "utf8", stdio: "pipe", shell: process.platform === "win32" }))[0];
        assert.deepEqual(packed.files.map(file => file.path).sort(), ["dist/cli.js", "package.json"]);
        assert.equal(await checkTarball(join(scratch, packed.filename)), 2);
        const guard = fileURLToPath(new URL("../scripts/check-package.mjs", import.meta.url));
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "aimcp-privacy-fixture", version: "1.0.0", files: ["dist/**/*.js", "dist/**/*.css"], scripts: { prepack: `node "${guard}"` } }));
        const lifecycleOutput = execFileSync(npm, ["pack", "--json"], { cwd: scratch, encoding: "utf8", stdio: "pipe", shell: process.platform === "win32" });
        assert.equal(JSON.parse(lifecycleOutput)[0].filename, packed.filename, "the guard must preserve npm's machine-readable JSON output");
        // Inspect real archive bytes as well as npm's dry-run list.
        writeFileSync(join(scratch, "dist/leak.js"), "PRIVATE_FIXTURE");
        mkdirSync(join(scratch, "package"));
        writeFileSync(join(scratch, "package/cli.js"), "fixture");
        await create({ cwd: scratch, file: join(scratch, "invalid.tgz"), gzip: true }, ["package/cli.js"]);
        await assert.rejects(checkTarball(join(scratch, "invalid.tgz")), /不允许/);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
});
