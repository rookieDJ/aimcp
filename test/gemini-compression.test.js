import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "aimcp-native-compression-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const { inspectGeminiCompression, configureGeminiCompression } = await import("../dist/control/services.js");
const { createControllerHttpServer } = await import("../dist/control/http-server.js");
const dir = join(home, ".gemini"); const path = join(dir, "settings.json");
test.after(() => rmSync(home, { recursive: true, force: true }));

test("Gemini user threshold edits preserve JSONC/secrets, use private atomic writes, and reject stale revisions", () => {
    assert.equal(inspectGeminiCompression().threshold, 0.5);
    assert.equal(inspectGeminiCompression().source, "default");
    mkdirSync(dir);
    const text = '{\n  // keep this comment\n  "security": { "fixtureSecret": "do-not-return" },\n  "model": { "name": "gemini-model", "compressionThreshold": 0.7, },\n}\n';
    writeFileSync(path, text);
    const initial = inspectGeminiCompression();
    assert.equal(JSON.stringify(initial).includes("do-not-return"), false);
    assert.equal(initial.threshold, 0.7);
    const next = configureGeminiCompression({ threshold: 0.3, revision: initial.revision });
    assert.equal(next.threshold, 0.3); assert.equal(next.requiresRestart, true);
    assert.match(readFileSync(path, "utf8"), /keep this comment/);
    assert.match(readFileSync(path, "utf8"), /do-not-return/);
    assert.match(readFileSync(path, "utf8"), /gemini-model/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => configureGeminiCompression({ threshold: 0.4, revision: initial.revision }), /其他程序修改/);
    assert.equal(inspectGeminiCompression().threshold, 0.3);
    for (const threshold of [0, 1, -1, NaN, Infinity, "0.5"]) assert.throws(() => configureGeminiCompression({ threshold, revision: next.revision }));
    const reset = configureGeminiCompression({ threshold: null, revision: next.revision });
    assert.equal(reset.source, "default"); assert.equal(reset.threshold, 0.5);
    assert.match(readFileSync(path, "utf8"), /keep this comment/);
    assert.equal(readFileSync(path, "utf8").includes("compressionThreshold"), false);
    writeFileSync(path, '{"model": BROKEN, "private": "hidden"}');
    assert.throws(() => inspectGeminiCompression(), error => /格式无效/.test(error.message) && !error.message.includes("hidden"));
    assert.throws(() => configureGeminiCompression({ threshold: 0.4, revision: reset.revision }));
    assert.match(readFileSync(path, "utf8"), /BROKEN/);
    writeFileSync(path, '{"model":{"compressionThreshold":0.7},"model":{"compressionThreshold":0.2}}');
    assert.throws(() => inspectGeminiCompression(), /重复字段/);
    assert.throws(() => configureGeminiCompression({ threshold: 0.4, revision: reset.revision }));
    rmSync(dir, { recursive: true });
});

test("native compression refuses linked configuration files/directories without altering their targets", () => {
    const outside = join(home, "outside"); mkdirSync(outside); const target = join(outside, "settings.json"); writeFileSync(target, "{}\n");
    symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => inspectGeminiCompression(), /真实目录/); unlinkSync(dir);
    mkdirSync(dir); symlinkSync(target, path);
    assert.throws(() => inspectGeminiCompression(), /安全读取/);
    assert.equal(readFileSync(target, "utf8"), "{}\n");
    rmSync(dir, { recursive: true }); rmSync(outside, { recursive: true });
});

test("native configuration Controller API requires local session, Origin and CSRF, and returns no unrelated configuration", async t => {
    mkdirSync(dir); writeFileSync(path, '{"mcpServers":{"private":{"token":"fixture-not-for-dom"}}}');
    const controller = createControllerHttpServer({ state: { schemaVersion: 1, apiVersion: 1, pid: process.pid, host: "127.0.0.1", controlToken: "fixture-controller", startedAt: new Date().toISOString(), version: "1.2.3" }, onShutdown: async () => {}, onReplaced: async () => {} });
    t.after(async () => { await controller.close(); rmSync(dir, { recursive: true }); });
    await controller.listen(); const base = `http://127.0.0.1:${controller.getPort()}`;
    const endpoint = base + "/api/gemini/compression";
    assert.equal((await fetch(endpoint)).status, 401);
    const landing = await fetch(base); const cookie = landing.headers.get("set-cookie").split(";")[0]; const csrf = (await landing.text()).match(/data-csrf-token="([^"]+)"/)[1];
    const result = await (await fetch(endpoint, { headers: { cookie } })).json();
    assert.equal(JSON.stringify(result).includes("fixture-not-for-dom"), false);
    const body = JSON.stringify({ threshold: 0.4, revision: result.compression.revision });
    const put = headers => fetch(endpoint, { method: "PUT", headers: { cookie, "content-type": "application/json", ...headers }, body });
    assert.equal((await put({ origin: base })).status, 403);
    assert.equal((await put({ origin: "https://evil.example", "x-csrf-token": csrf })).status, 403);
    const saved = await put({ origin: base, "x-csrf-token": csrf }); assert.equal(saved.status, 200);
    assert.equal((await saved.json()).compression.threshold, 0.4);
    assert.equal((await put({ origin: base, "x-csrf-token": csrf })).status, 400);
    assert.match(readFileSync(path, "utf8"), /fixture-not-for-dom/);
});
