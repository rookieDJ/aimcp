import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "aimcp-conversation-names-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const { saveUserConfig } = await import("../dist/config/user-config.js");
const { saveConversationUse, conversationId, readConversation, listConversationRecords, renameConversation, deleteConversation } = await import("../dist/projects/conversations.js");
const { createControllerHttpServer } = await import("../dist/control/http-server.js");
const project = { id: "fixture-project", name: "测试项目", path: home, active: true, lastSeenAt: new Date().toISOString() };
const options = { client: "gemini", boundAt: new Date().toISOString() };

test("unnamed sessions have stable distinct display names without exposing messages; manual names survive client writes", async () => {
    saveUserConfig({ saveConversations: true });
    const a = "local:noauth|project-session:naming-a", b = "local:noauth|project-session:naming-b";
    await saveConversationUse(a, project, { ...options, messages: [{ id: "u1", role: "user", content: "DO_NOT_DISPLAY_PRIVATE_CONTENT" }] });
    await saveConversationUse(b, project, options);
    const id = conversationId(a), path = join(home, ".ai-mcp/conversations", `${id}.json`);
    const before = readFileSync(path, "utf8");
    const records = listConversationRecords([], [project]).records;
    assert.equal(new Set(records.map(r => r.displayTitle)).size, 2);
    assert.ok(records.every(r => r.displayTitle.includes("Gemini · 测试项目")));
    assert.equal(records.some(r => r.displayTitle.includes("DO_NOT_DISPLAY")), false);
    assert.equal(readFileSync(path, "utf8"), before); // Reads do not migrate or rewrite archives.
    await renameConversation(id, "  修复登录流程  ", null);
    await saveConversationUse(a, project, { ...options, title: "client tries to overwrite", messages: [{ id: "a1", role: "assistant", content: "next" }] });
    assert.equal(readConversation(id).title, "修复登录流程");
    assert.equal(readConversation(id).messages.length, 2);
    await assert.rejects(renameConversation(id, "stale", null), /已被其他/);
    await assert.rejects(renameConversation(id, "   ", "修复登录流程"));
    await assert.rejects(renameConversation(id, "x".repeat(201), "修复登录流程"));
    saveUserConfig({ saveConversations: false });
    await renameConversation(id, "手动名称", "修复登录流程"); // Explicit local edit still works with collection off.
    await saveConversationUse(a, project, { ...options, title: "DO_NOT_STORE" });
    assert.equal(readConversation(id).title, "手动名称");
    await deleteConversation(id);
    await assert.rejects(renameConversation(id, "cannot resurrect", "手动名称"), /已删除/);
    assert.equal(readConversation(id), undefined);
});

test("conversation rename requires local session, origin, CSRF and matching original title", async t => {
    saveUserConfig({ saveConversations: true });
    const owner = "local:noauth|project-session:naming-http", id = conversationId(owner);
    await saveConversationUse(owner, project, { ...options, title: "原名" });
    const controller = createControllerHttpServer({ state: { schemaVersion: 1, apiVersion: 1, pid: process.pid, host: "127.0.0.1", controlToken: randomBytes(32).toString("hex"), startedAt: new Date().toISOString(), version: "fixture" }, onShutdown: async () => {}, onReplaced: async () => {} });
    await controller.listen();
    t.after(async () => { await controller.close(); rmSync(home, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${controller.getPort()}`, endpoint = `${base}/api/conversations/${id}/title`;
    const page = await fetch(base), html = await page.text();
    const cookie = page.headers.get("set-cookie").split(";")[0], csrf = html.match(/data-csrf-token="([^"]+)"/)[1];
    const request = { method: "PUT", headers: { "content-type": "application/json", cookie, origin: base, "x-csrf-token": csrf }, body: JSON.stringify({ title: "新名", expectedTitle: "原名" }) };
    assert.equal((await fetch(endpoint, { ...request, headers: { "content-type": "application/json" } })).status, 401);
    assert.equal((await fetch(endpoint, { ...request, headers: { ...request.headers, "x-csrf-token": "wrong" } })).status, 403);
    assert.equal((await fetch(endpoint, { ...request, headers: { ...request.headers, origin: "https://foreign.example" } })).status, 403);
    assert.equal((await fetch(endpoint, request)).status, 200);
    assert.equal((await fetch(endpoint, request)).status, 400);
    assert.equal(readConversation(id).title, "新名");
});
