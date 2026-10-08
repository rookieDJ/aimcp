import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "aimcp-remove-registration-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODING_MCP_LOG_TOOLS = "0";
after(() => rmSync(home, { recursive: true, force: true }));
const { ProjectRegistry } = await import("../dist/projects/registry.js");
const { BindingStore } = await import("../dist/projects/bindings.js");
const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");
const { createHttpServer } = await import("../dist/server/http-server.js");
const { loadConfig } = await import("../dist/config/loader.js");
const { removeProject } = await import("../dist/control/services.js");
const { loadProjectsFile, loadBindingsFile } = await import("../dist/daemon/state.js");

test("offline removal cancels registration and bindings, preserves files, and allows re-adding", async () => {
    const path = join(home, "offline");
    mkdirSync(path);
    writeFileSync(join(path, "keep.txt"), "keep");
    const registry = new ProjectRegistry({ projects: [] });
    const project = await registry.register({ path });
    const bindings = new BindingStore({ bindings: [] });
    await bindings.bind("local:noauth|openai-session:fixture", project.id);
    assert.equal((await removeProject(project.id, { forget: true })).removed, true);
    assert.deepEqual(loadProjectsFile(), []);
    assert.deepEqual(loadBindingsFile(), []);
    assert.equal(existsSync(join(path, "keep.txt")), true);
    assert.equal((await new ProjectRegistry().register({ path })).active, true);
});

test("online removal retains a retryable registration on cleanup failure and isolates other projects", async t => {
    const registry = new ProjectRegistry({ projects: [], save: async () => {} });
    const project = await registry.register({ path: home });
    const path = join(home, "other");
    mkdirSync(path);
    const other = await registry.register({ path });
    const bindings = new BindingStore({ bindings: [], save: async () => {} });
    await bindings.bind("owner-a", project.id);
    await bindings.bind("owner-b", other.id);
    const runtimes = new ProjectRuntimeManager();
    const runtime = runtimes.get(project.id, home);
    runtimes.get(other.id, path);
    const shutdown = runtime.processOwners.shutdown.bind(runtime.processOwners);
    runtime.processOwners.shutdown = async () => { throw new Error("fixture cleanup failed"); };
    const server = createHttpServer(loadConfig({ projectRoot: home, local: true, userConfig: { port: 0 } }), {
        daemon: { registry, bindings, runtimes, controlToken: "fixture-removal-control", runtimeIntent: { local: true, noTunnel: false, tunnelLogs: false }, tunnelStatus: () => ({ running: false, state: "off" }), onShutdown: async () => {} },
    });
    await server.listen();
    t.after(() => server.close());
    const endpoint = new URL(`/daemon/projects/${encodeURIComponent(project.id)}?forget=true`, server.getMcpUrl());
    const options = { method: "DELETE", headers: { "x-codex-control-token": "fixture-removal-control" } };
    assert.equal((await fetch(endpoint, { method: "DELETE" })).status, 401);
    assert.equal(registry.getById(project.id).active, true);
    assert.equal((await fetch(endpoint, options)).status, 400);
    assert.equal(registry.getById(project.id).active, false);
    assert.equal(runtimes.has(project.id), true);
    runtime.processOwners.shutdown = shutdown;
    assert.equal((await fetch(endpoint, options)).status, 200);
    assert.equal(registry.getById(project.id), undefined);
    assert.equal(runtimes.has(project.id), false);
    assert.equal(bindings.countForProject(project.id), 0);
    assert.equal(registry.getById(other.id).active, true);
    assert.equal(runtimes.has(other.id), true);
    assert.equal(bindings.countForProject(other.id), 1);
    assert.equal((await fetch(new URL("/healthz", endpoint))).status, 200);
    assert.equal((await registry.register({ path: home })).active, true);
});

test("registry forgetting commits only after persistence and rejects a reactivated project", async () => {
    let fail = false;
    const registry = new ProjectRegistry({ projects: [], save: async () => { if (fail) throw new Error("fixture write failed"); } });
    const project = await registry.register({ path: home });
    await assert.rejects(registry.removeInactiveById(project.id), /重新启用/);
    await registry.deactivateById(project.id);
    fail = true;
    await assert.rejects(registry.removeInactiveById(project.id), /write failed/);
    assert.equal(registry.getById(project.id).active, false);
    fail = false;
    await registry.removeInactiveById(project.id);
    assert.deepEqual(registry.list(), []);
});
