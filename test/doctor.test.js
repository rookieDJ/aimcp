import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aimcp-doctor-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const dir = join(home, ".ai-mcp");
mkdirSync(dir);
const { runDoctorChecks, validateDoctorOAuthMetadata } = await import("../dist/doctor/index.js");
const { runDoctorService } = await import("../dist/control/services.js");

test("doctor preserves a useful report when durable project, binding or daemon state is corrupt", async () => {
    for (const file of ["projects.json", "session-bindings.json", "daemon.json"]) writeFileSync(join(dir, file), "{invalid");
    try {
        const report = await runDoctorChecks();
        for (const label of ["项目登记", "会话绑定", "守护进程"]) assert.equal(report.checks.find(c => c.label === label)?.level, "error");
        assert.ok(report.checks.some(c => c.label === "Node.js" && c.level === "ok"));
        assert.ok(report.checkedAt);
        assert.ok(report.errors >= 3);
    } finally { for (const file of ["projects.json", "session-bindings.json", "daemon.json"]) rmSync(join(dir, file), { force: true }); }
});

test("doctor reports a missing project path without deleting its registration", async () => {
    const now = new Date().toISOString();
    const project = { id: "fixture", name: "fixture", path: join(home, "missing"), active: true, addedAt: now, lastSeenAt: now };
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ schemaVersion: 1, projects: [project] }));
    try {
        const report = await runDoctorChecks();
        const check = report.checks.find(c => c.label === "项目目录");
        assert.equal(check?.level, "error");
        assert.match(check.hint, /项目/);
    } finally { rmSync(join(dir, "projects.json"), { force: true }); }
});

test("doctor respects cancellation before starting diagnostics", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel doctor"));
    await assert.rejects(runDoctorChecks({ signal: controller.signal }), /cancel doctor/);
});

test("doctor fix retains corrupt state and does not start a stopped Runtime", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const file = join(dir, "daemon.json");
    writeFileSync(file, "{invalid");
    try {
        const result = await runDoctorService(true);
        assert.equal(result.report.checks.find(c => c.label === "守护进程")?.level, "error");
        assert.ok(result.warnings.some(w => /保留原文件/.test(w)));
        assert.equal(readFileSync(file, "utf8"), "{invalid");
        assert.equal(existsSync(join(dir, "controller.json")), false);
    } finally { rmSync(file, { force: true }); }
});

test("connector recovery API keeps project bindings and requires the local control token", async t => {
    const { createHttpServer } = await import("../dist/server/http-server.js");
    const { loadConfig } = await import("../dist/config/loader.js");
    const { ProjectRegistry } = await import("../dist/projects/registry.js");
    const { BindingStore } = await import("../dist/projects/bindings.js");
    const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");
    const { DaemonControlClient } = await import("../dist/daemon/control.js");
    const { setAdminPassword } = await import("../dist/auth/password-store.js");
    await setAdminPassword("doctor-fixture-password");
    const registry = new ProjectRegistry({ projects: [], save: async () => {} });
    const project = await registry.register({ path: home });
    const now = new Date().toISOString();
    const bindings = new BindingStore({ bindings: [{ ownerKey: "test", projectId: project.id, boundAt: now, lastSeenAt: now }], save: async () => {} });
    let recoveries = 0;
    const intent = { local: false, noTunnel: false, tunnelLogs: false };
    const server = createHttpServer(loadConfig({ projectRoot: home, userConfig: { port: 0, publicAccess: { kind: "external", domain: "recovery.example.com" } }, local: false }), {
        daemon: { registry, bindings, runtimes: new ProjectRuntimeManager(), controlToken: "recovery-test", runtimeIntent: intent, tunnelStatus: () => ({ running: true, state: "connected" }), onShutdown: async () => {}, onRecoverTunnel: async () => { await new Promise(resolve => setTimeout(resolve, 50)); recoveries++; } },
    });
    await server.listen(); t.after(() => server.close());
    const endpoint = new URL("/daemon/tunnel/recover", server.getMcpUrl());
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "x-codex-control-token": "recovery-test", Origin: "https://foreign.example" } })).status, 403);
    assert.equal(recoveries, 0);
    const before = await new DaemonControlClient(server.getPort(), "recovery-test").status();
    const client = new DaemonControlClient(server.getPort(), "recovery-test", 5);
    await client.recoverTunnel(); // The lifecycle request must not inherit the 5ms probe deadline.
    assert.equal(recoveries, 1);
    assert.equal(bindings.list().length, 1);
    assert.equal(registry.list().length, 1);
    const after = await new DaemonControlClient(server.getPort(), "recovery-test").status();
    assert.equal(after.pid, before.pid);
    assert.equal(after.projects[0].boundSessions, 1);
    assert.equal((await new DaemonControlClient(server.getPort(), "recovery-test").checkTools()).projectCount, 1);
    intent.noTunnel = true;
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "x-codex-control-token": "recovery-test" } })).status, 409);
    assert.equal(recoveries, 1);
});

test("doctor OAuth checks accept actual path-specific discovery and reject cross-host endpoints or missing PKCE", async t => {
    const { createHttpServer } = await import("../dist/server/http-server.js");
    const { loadConfig } = await import("../dist/config/loader.js");
    const domain = "doctor.example.com";
    const { setAdminPassword } = await import("../dist/auth/password-store.js");
    await setAdminPassword("doctor-fixture-password");
    const server = createHttpServer(loadConfig({ projectRoot: home, userConfig: { port: 0, publicAccess: { kind: "external", domain } }, local: false }));
    await server.listen(); t.after(() => server.close());
    const get = async path => fetch(new URL(path, server.getMcpUrl()), { headers: { Host: domain } });
    const resourceResponse = await get("/.well-known/oauth-protected-resource/mcp");
    const authResponse = await get("/.well-known/oauth-authorization-server");
    assert.equal(resourceResponse.status, 200);
    assert.equal(authResponse.status, 200);
    const resource = await resourceResponse.json(), authorization = await authResponse.json();
    assert.doesNotThrow(() => validateDoctorOAuthMetadata(domain, resource, authorization));
    const challenge = await get("/mcp");
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("www-authenticate"), /Bearer/);
    assert.throws(() => validateDoctorOAuthMetadata(domain, resource, { ...authorization, token_endpoint: "https://foreign.example/token" }));
    assert.throws(() => validateDoctorOAuthMetadata(domain, resource, { ...authorization, code_challenge_methods_supported: ["plain"] }));
    assert.throws(() => validateDoctorOAuthMetadata(domain, { ...resource, resource: "https://foreign.example/mcp" }, authorization));
});
