import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = mkdtempSync(join(tmpdir(), "aimcp-project-session-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODING_MCP_LOG_TOOLS = "0";
const { createHttpServer } = await import("../dist/server/http-server.js");
const { loadConfig } = await import("../dist/config/loader.js");
const { ProjectRegistry } = await import("../dist/projects/registry.js");
const { BindingStore } = await import("../dist/projects/bindings.js");
const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");

test("explicit project sessions survive missing metadata and reconnects without borrowing another conversation", async t => {
    const registry = new ProjectRegistry({ projects: [], save: async () => {} });
    const projects = [];
    for (const name of ["alpha", "beta"]) {
        const path = join(home, name);
        mkdirSync(path);
        writeFileSync(join(path, "marker.txt"), name);
        projects.push(await registry.register({ path }));
    }
    let bindings = new BindingStore({ bindings: [] });
    let server;
    let client;
    const connect = async () => {
        server = createHttpServer(loadConfig({ projectRoot: home, local: true, userConfig: { port: 0 } }), {
            daemon: { registry, bindings, runtimes: new ProjectRuntimeManager(), controlToken: "test-control-token", runtimeIntent: { local: true, noTunnel: false, tunnelLogs: false }, tunnelStatus: () => ({ running: false, state: "off" }), onShutdown: async () => {} },
        });
        await server.listen();
        client = new Client({ name: "session-regression", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(server.getMcpUrl())));
    };
    t.after(async () => {
        try { await client?.close(); await server?.close(); }
        finally { rmSync(home, { recursive: true, force: true }); }
    });
    await connect();
    const call = (name, args, session) => client.callTool({ name, arguments: { purpose: "Verify project session", ...args }, ...(session ? { _meta: { "openai/session": session } } : {}) });
    const select = async (index, session) => {
        const result = await call("project_control", { action: "select", project_id: projects[index].id }, session);
        assert.equal(result.isError === true, false);
        assert.match(result.structuredContent.project_session, /^[a-f0-9]{64}$/);
        return result.structuredContent.project_session;
    };
    const read = async (handle, expected, session) => {
        const result = await call("read", { path: "marker.txt", ...(handle ? { project_session: handle } : {}) }, session);
        assert.equal(result.isError === true, expected === null, JSON.stringify(result));
        if (expected !== null) assert.match(result.structuredContent.text, new RegExp(expected));
    };
    const chat = await select(0, "chat-a");
    await read(undefined, "alpha", "chat-a"); // Existing clients remain compatible.
    await read(chat, "alpha"); // ChatGPT omitted its per-call metadata.
    await read(chat, "alpha", "chat-a-reconnected");
    await read(undefined, null);
    await read(undefined, null, "unselected-chat");
    await read("0".repeat(64), null);
    const geminiA = await select(0);
    const geminiB = await select(1);
    assert.notEqual(geminiA, geminiB);
    await Promise.all([read(geminiA, "alpha"), read(geminiB, "beta"), read(chat, "alpha", "chat-a")]);
    await read(undefined, null);
    for (const tool of (await client.listTools()).tools) assert.ok(tool.inputSchema.properties.project_session, tool.name);
    const foreign = new BindingStore({ bindings: bindings.list(), save: async () => {} });
    assert.equal(foreign.resolveProjectSession("oauth:another-client", chat), undefined);
    assert.equal(foreign.resolveProjectSession("local:noauth-extra", chat), undefined);
    assert.equal(foreign.resolveProjectSession("local:noauth", chat)?.projectId, projects[0].id);
    const deniedSwitch = await call("project_control", { action: "select", project_id: projects[1].id, project_session: geminiA });
    assert.equal(deniedSwitch.isError, true);
    const switched = await call("project_control", { action: "select", project_id: projects[1].id, project_session: geminiA, force: true });
    assert.equal(switched.isError === true, false);
    assert.equal(switched.structuredContent.project_session, geminiA);
    await read(geminiA, "beta");
    const escaped = await call("read", { path: join(projects[0].path, "marker.txt"), project_session: geminiA });
    assert.equal(escaped.isError, true);
    // Both handles now select beta, but must still own independent process pools.
    writeFileSync(join(projects[1].path, "wait.cjs"), "process.stdout.write('READY\\n'); process.stdin.on('data', () => process.exit(0));");
    const quote = value => `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
    const processResult = await call("exec_command", { project_session: geminiB, cmd: `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(join(projects[1].path, "wait.cjs"))}`, yield_time_ms: 100 });
    assert.equal(processResult.isError === true, false);
    assert.equal(processResult.structuredContent.running, true);
    const sessionId = processResult.structuredContent.session_id;
    const deniedPoll = await call("write_stdin", { project_session: geminiA, session_id: sessionId, chars: "bad\n", yield_time_ms: 0 });
    assert.equal(deniedPoll.isError, true);
    const stopped = await call("write_stdin", { project_session: geminiB, session_id: sessionId, chars: "exit\n", yield_time_ms: 1000 });
    assert.equal(stopped.isError === true, false);
    assert.equal(stopped.structuredContent.running, false);
    await client.close();
    await server.close();
    bindings = new BindingStore(); // Durable handles remain valid after a Runtime restart.
    await connect();
    const current = await call("project_control", { action: "current", project_session: chat });
    assert.equal(current.structuredContent.project_session, chat);
    assert.equal(current.structuredContent.project.id, projects[0].id);
    await read(chat, "alpha");
    await read(geminiA, "beta");
    const unbound = await call("project_control", { action: "unbind", project_session: geminiA });
    assert.equal(unbound.isError === true, false);
    assert.equal(unbound.structuredContent.project_session, null);
    await read(geminiA, null);
    await read(geminiB, "beta");
    await registry.deactivateById(projects[0].id);
    await read(chat, null);
});
