import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

const home = mkdtempSync(join(tmpdir(), "aimcp-privacy-"));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.CODING_MCP_LOG_TOOLS = "1";
const config = await import("../dist/config/user-config.js");
const archive = await import("../dist/projects/conversations.js");
const logging = await import("../dist/lib/runtime-log.js");
const { registerTool, logMcpEvent } = await import("../dist/lib/tool/log.js");
const { CodexClientsStore } = await import("../dist/auth/provider.js");
const { createTokenEndpoint } = await import("../dist/auth/endpoints.js");
const { openPrivateAppendFile } = await import("../dist/lib/fs/atomic-file.js");

test("unconfigured installations do not archive chat; explicit opt-in is required", async () => {
    assert.equal(config.isConversationRecordingEnabled(), false);
    const result = await archive.saveConversationUse("fixture-owner", { id: "fixture", name: "fixture" }, {
        boundAt: new Date().toISOString(), messages: [{ id: "m1", role: "user", content: "private fixture chat" }],
    });
    assert.equal(result.recordingEnabled, false);
    assert.deepEqual(readdirSync(home), []);
});

test("private directories and logs exclude arbitrary tool input, output and error text", async () => {
    const directory = config.getUserLogDir();
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(config.getUserConfigDir(), 0o755); chmodSync(directory, 0o755);
    writeFileSync(join(directory, "codex-mcp.legacy.jsonl"), "old fixture\n", { mode: 0o644 });
    config.ensureUserConfigDirs();
    await logging.initializeRuntimeLog();
    const secret = "fixture-private-payload-do-not-log";
    const fields = { password: secret, purpose: secret, error: secret, stack: secret, content: secret, unknownField: secret, status: 400, durationMs: 12 };
    let output = "";
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    process.stdout.write = process.stderr.write = function (chunk, ...args) {
        output += String(chunk); const callback = args.find(arg => typeof arg === "function"); callback?.(); return true;
    };
    try {
        logging.writeRuntimeLog("warn", "privacy_fixture", fields);
        logMcpEvent("privacy_fixture", fields);
        let handler;
        const server = { registerTool(_name, _config, fn) { handler = fn; } };
        const context = { mcpReq: {} };
        registerTool(server, "exec_command", {}, async () => ({ content: [{ type: "text", text: secret }] }));
        await handler({ purpose: secret, cmd: secret }, context);
        registerTool(server, "summary", {}, async () => ({ content: [{ type: "text", text: secret }], isError: true }));
        await handler({ purpose: secret, summary: secret }, context);
        registerTool(server, "read", {}, async () => { throw new Error(secret); });
        await assert.rejects(handler({ purpose: secret, path: secret }, context), /fixture-private-payload/);
    } finally {
        process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite;
        logging.closeRuntimeLog();
    }
    assert.equal(output.includes(secret), false, "terminal logs must not copy tool payloads or error text");
    const files = readdirSync(directory).filter(name => name.endsWith(".jsonl"));
    assert.ok(files.length);
    const text = files.map(name => readFileSync(join(directory, name), "utf8")).join("\n");
    assert.equal(text.includes(secret), false, "file logs must not persist free-form input/error fields");
    assert.match(text, /tool_call_started/); assert.match(text, /"status":400/);
    if (process.platform !== "win32") {
        for (const dir of [config.getUserConfigDir(), directory]) assert.equal(statSync(dir).mode & 0o777, 0o700);
        for (const file of files) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
    }
});

test("OAuth failure diagnostics do not log client URLs or internal error text", async () => {
    const secret = "private-oauth-fixture-do-not-log";
    const app = express();
    app.use("/token", createTokenEndpoint({ authenticateClient: async () => { throw new Error(secret); } }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    let output = "";
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
    process.stdout.write = process.stderr.write = function (chunk, ...args) {
        output += String(chunk); args.find(arg => typeof arg === "function")?.(); return true;
    };
    try {
        const clients = new CodexClientsStore({ getClient: () => undefined }, new URL("https://mcp.example.com/"));
        assert.equal(await clients.getClient(`https://127.0.0.1/${secret}`), undefined);
        const response = await fetch(`http://127.0.0.1:${server.address().port}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=fixture" });
        assert.equal(response.status, 500);
        assert.equal((await response.text()).includes(secret), false);
    } finally {
        process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite;
        await new Promise(resolve => server.close(resolve));
    }
    assert.equal(output.includes(secret), false);
});

test("private state directory cannot be redirected through a symbolic link", { skip: process.platform === "win32" }, () => {
    const directory = config.getUserLogDir();
    rmSync(directory, { recursive: true });
    const outside = join(home, "outside"); mkdirSync(outside);
    symlinkSync(outside, directory, "dir");
    assert.throws(() => config.ensureUserConfigDirs(), /私有目录/);
    assert.equal(readdirSync(outside).length, 0);
});

test("private append repairs old permissions and refuses symlinks", { skip: process.platform === "win32" }, () => {
    const path = join(home, "append-fixture.log");
    writeFileSync(path, "fixture", { mode: 0o644 });
    closeSync(openPrivateAppendFile(path));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(home, "redirect.log"); symlinkSync(path, link);
    assert.throws(() => openPrivateAppendFile(link));
    assert.equal(readFileSync(path, "utf8"), "fixture");
});

test.after(() => { logging.closeRuntimeLog(); rmSync(home, { recursive: true, force: true }); });
