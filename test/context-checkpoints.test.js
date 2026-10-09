import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = mkdtempSync(join(tmpdir(), "aimcp-checkpoints-"));
process.env.HOME = home; process.env.USERPROFILE = home; process.env.CODING_MCP_LOG_TOOLS = "0";
const { createHttpServer } = await import("../dist/server/http-server.js");
const { loadConfig } = await import("../dist/config/loader.js");
const { ProjectRegistry } = await import("../dist/projects/registry.js");
const { BindingStore } = await import("../dist/projects/bindings.js");
const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");
const { conversationId, readConversation, deleteConversation, listConversationRecords } = await import("../dist/projects/conversations.js");
const { saveUserConfig } = await import("../dist/config/user-config.js");
const { ContextProgress } = await import("../dist/projects/context-progress.js");

test("checkpoints persist across reconnect, isolate projects/clients, respect privacy and deletion, and reject stale writes", async t => {
    saveUserConfig({ saveConversations: true });
    const registry = new ProjectRegistry({ projects: [] });
    const projects = [];
    for (const name of ["alpha", "beta"]) {
        const path = join(home, name); mkdirSync(path); writeFileSync(join(path, "marker.txt"), name);
        projects.push(await registry.register({ path }));
    }
    let bindings = new BindingStore({ bindings: [] });
    let server; let client;
    const connect = async () => {
        server = createHttpServer(loadConfig({ projectRoot: home, local: true, userConfig: { port: 0 } }), { daemon: { registry, bindings, runtimes: new ProjectRuntimeManager(), controlToken: "fixture", runtimeIntent: { local: true, noTunnel: false, tunnelLogs: false }, tunnelStatus: () => ({ running: false, state: "off" }), onShutdown: async () => {} } });
        await server.listen();
        client = new Client({ name: "checkpoint-fixture", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(server.getMcpUrl())));
    };
    t.after(async () => { try { await client?.close(); await server?.close(); } finally { rmSync(home, { recursive: true, force: true }); } });
    await connect();
    const control = args => client.callTool({ name: "project_control", arguments: { purpose: "Verify summary checkpoint", ...args } });
    const select = async kind => (await control({ action: "select", project_id: projects[0].id, client: kind })).structuredContent.project_session;
    const gemini = await select("gemini"); const gpt = await select("chatgpt");
    const checkpoint = { id: "first", previous_id: null, summary: "fixture <img src=x onerror=alert(1)> completed state", next_steps: ["verify actual files"] };
    const save = (value = checkpoint, handle = gemini) => control({ action: "checkpoint", project_session: handle, checkpoint: value });
    const restore = (handle = gemini) => control({ action: "restore", project_session: handle });
    const first = await save();
    assert.equal(first.isError === true, false); assert.equal(first.structuredContent.checkpoint_saved, true);
    assert.equal(JSON.stringify(first).includes(checkpoint.summary), false); // Do not echo private bodies on writes.
    assert.equal((await save()).isError === true, false);
    assert.equal((await save({ ...checkpoint, summary: "conflicting retry" })).isError, true);
    assert.equal((await control({ action: "current", project_session: gemini, checkpoint })).isError, true);
    assert.equal((await control({ action: "checkpoint", checkpoint })).isError, true);
    assert.equal((await restore("0".repeat(64))).isError, true);
    assert.equal((await restore(gpt)).structuredContent.checkpoint, null);
    assert.equal((await restore()).structuredContent.checkpoint.summary, checkpoint.summary);
    const id = conversationId(bindings.resolveProjectSession("local:noauth", gemini).ownerKey);
    const path = join(home, ".ai-mcp/conversations", `${id}.json`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const now = readConversation(id).checkpoints[0].savedAt;
    assert.equal(listConversationRecords(bindings.list(), registry.list()).records.find(item => item.id === id).checkpointAt, now);
    // Reminder based on bounded MCP activity, isolated per owner; saving resets it.
    const read = handle => client.callTool({ name: "read", arguments: { purpose: "Read marker", path: "marker.txt", project_session: handle } });
    const reminder = result => JSON.stringify(result.content).includes("长任务检查点提醒");
    for (let i = 0; i < 19; i++) assert.equal(reminder(await read(gemini)), false);
    assert.equal(reminder(await read(gemini)), true);
    assert.equal(reminder(await read(gpt)), false);
    const second = { ...checkpoint, id: "second", previous_id: "first", summary: "newer state" };
    await save(second);
    assert.equal(reminder(await read(gemini)), false);
    assert.equal((await save()).isError, true); // Old retry cannot roll back a newer checkpoint.
    assert.equal((await save({ ...second, id: "third", previous_id: "wrong" })).isError, true);
    assert.equal((await restore()).structuredContent.checkpoint.id, "second");
    assert.equal((await control({ action: "select", project_session: gemini, project_id: projects[1].id, force: true, client: "chatgpt" })).isError, true);
    await control({ action: "select", project_session: gemini, project_id: projects[1].id, force: true });
    assert.equal((await restore()).structuredContent.checkpoint, null);
    await save({ ...checkpoint, summary: "beta only" });
    await control({ action: "select", project_session: gemini, project_id: projects[0].id, force: true });
    assert.equal((await restore()).structuredContent.checkpoint.summary, "newer state");
    await client.close(); await server.close();
    bindings = new BindingStore(); await connect();
    assert.equal((await restore()).structuredContent.checkpoint.id, "second");
    saveUserConfig({ saveConversations: false });
    const before = readFileSync(path, "utf8");
    assert.equal((await restore()).structuredContent.checkpoint, null);
    assert.equal((await save({ ...second, id: "off", previous_id: "second" })).structuredContent.checkpoint_saved, false);
    for (let i = 0; i < 21; i++) assert.equal(reminder(await read(gemini)), false);
    assert.equal(readFileSync(path, "utf8"), before);
    saveUserConfig({ saveConversations: true });
    await deleteConversation(id);
    assert.equal((await restore()).structuredContent.checkpoint, null);
    assert.equal(readConversation(id), undefined);
    assert.equal((await save({ ...second, id: "after-delete", previous_id: "second" })).isError, true);
    await control({ action: "unbind", project_session: gemini });
    assert.equal((await restore()).isError, true);
});

test("activity counts are numeric, independent, resettable and trigger for a large output", () => {
    const progress = new ContextProgress();
    assert.equal(progress.observe("a", 64 * 1024), true);
    assert.equal(progress.observe("a", 1), false); // Do not repeat the same reminder on every following call.
    assert.equal(progress.observe("b", 1), false);
    progress.reset("a"); assert.equal(progress.observe("a", 1), false);
    for (let i = 0; i < 1100; i++) progress.observe(`abandoned-${i}`, 1);
    assert.equal(progress.observe("a", 1), false);
});
