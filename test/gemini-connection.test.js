import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "aimcp-gemini-connection-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODING_MCP_LOG_TOOLS = "0";
const { createHttpServer } = await import("../dist/server/http-server.js");
const { loadConfig } = await import("../dist/config/loader.js");
const { setAdminPassword } = await import("../dist/auth/password-store.js");
const { ProjectRegistry } = await import("../dist/projects/registry.js");
const { BindingStore } = await import("../dist/projects/bindings.js");
const { ProjectRuntimeManager } = await import("../dist/projects/runtime.js");
const { DaemonControlClient } = await import("../dist/daemon/control.js");

test("Google callbacks and project reads work with Mac and Windows browser headers; OAuth boundaries remain enforced", async t => {
    const password = "gemini-test-only-password-123!";
    await setAdminPassword(password);
    writeFileSync(join(home, "marker.txt"), "isolated Gemini project fixture");
    const registry = new ProjectRegistry({ projects: [], save: async () => {} });
    const project = await registry.register({ path: home });
    const server = createHttpServer(loadConfig({ projectRoot: home, userConfig: { port: 0, publicAccess: { kind: "external", domain: "gemini.example.com" } } }), {
        daemon: { registry, bindings: new BindingStore({ bindings: [], save: async () => {} }), runtimes: new ProjectRuntimeManager(), controlToken: "gemini-fixture-control", runtimeIntent: { local: false, noTunnel: true, tunnelLogs: false }, tunnelStatus: () => ({ running: false, state: "off" }), onShutdown: async () => {} },
    });
    await server.listen();
    t.after(async () => { await server.close(); rmSync(home, { recursive: true, force: true }); });
    const base = new URL(server.getMcpUrl());
    const request = (path, options = {}) => fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(5000), ...options });
    const callbacks = ["sandbox", "test", ""].flatMap(kind => ["", "?variant=fixture"].map(query => `https://oauth-redirect${kind ? `-${kind}` : ""}.googleusercontent.com/r/fixture${query}`));
    const registration = await request("/register", { method: "POST", headers: { "content-type": "application/json", "user-agent": "OpenAuth" }, body: JSON.stringify({ client_name: "Google", redirect_uris: callbacks, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const resource = "https://gemini.example.com/mcp";
    const state = "fixture+state/&=中文".repeat(80);
    for (const [platform, ua] of [
        ["macos", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"],
        ["macos", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"],
        ["windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"],
    ]) {
        const verifier = "v".repeat(48);
        const form = { response_type: "code", client_id: client.client_id, redirect_uri: callbacks[4], code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "mcp:tools offline_access", resource, state };
        const page = await request(`/authorize?${new URLSearchParams(form)}`, { headers: { "user-agent": ua } });
        assert.equal(page.status, 200);
        const approve = await request("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://gemini.example.com", "user-agent": ua }, body: new URLSearchParams({ ...form, password }) });
        assert.equal(approve.status, 302);
        const callback = new URL(approve.headers.get("location"));
        assert.equal(callback.searchParams.get("state"), state);
        assert.equal(callback.searchParams.get("iss"), "https://gemini.example.com/");
        const tokenForm = { grant_type: "authorization_code", client_id: client.client_id, code: callback.searchParams.get("code"), code_verifier: verifier, redirect_uri: form.redirect_uri, resource };
        const exchange = overrides => request("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Google" }, body: new URLSearchParams({ ...tokenForm, ...overrides }) });
        assert.equal((await exchange({ resource: "https://foreign.example/mcp" })).status, 400);
        assert.equal((await exchange({ redirect_uri: callbacks[0] })).status, 400);
        assert.equal((await exchange({ code_verifier: "x".repeat(48) })).status, 400);
        const issued = await exchange({});
        assert.equal(issued.status, 200);
        const tokens = await issued.json();
        assert.equal((await exchange({})).status, 400);
        const rpc = async (method, params) => {
            const response = await request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}`, origin: "https://gemini.google.com", "user-agent": ua }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
            assert.equal(response.status, 200);
            const text = await response.text();
            return JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: ")).slice(6) : text).result;
        };
        const tools = await rpc("tools/list", {});
        assert.ok(tools.tools.some(tool => tool.name === "read"));
        const selected = await rpc("tools/call", { name: "project_control", arguments: { action: "select", project_id: project.id, client: "gemini", purpose: "Verify Gemini binding" } });
        assert.notEqual(selected.isError, true);
        const read = await rpc("tools/call", { name: "read", arguments: { path: "marker.txt", project_session: selected.structuredContent.project_session, purpose: "Verify Gemini project read" } });
        assert.notEqual(read.isError, true);
        assert.match(read.structuredContent.text, /isolated Gemini project fixture/);
        const invalidOrigin = await request("/authorize", { method: "POST", headers: { origin: "https://foreign.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...form, password }) });
        assert.equal(invalidOrigin.status, 403);
        const diagnostics = await new DaemonControlClient(server.getPort(), "gemini-fixture-control").oauthDiagnostics();
        assert.ok(diagnostics.events.some(event => event.endpoint === "authorize" && event.outcome === "approved" && event.platform === platform));
        assert.ok(diagnostics.events.some(event => event.endpoint === "token" && event.status === 200));
        assert.ok(diagnostics.events.some(event => event.endpoint === "mcp" && event.status === 200));
        const diagnosticText = JSON.stringify(diagnostics);
        for (const sensitive of [password, state, tokenForm.code, tokens.access_token, tokens.refresh_token, client.client_id, "marker.txt", "googleusercontent.com", ua]) assert.equal(diagnosticText.includes(sensitive), false);
    }
    assert.equal((await request("/daemon/oauth-diagnostics")).status, 401);
    assert.equal((await request("/daemon/oauth-diagnostics", { headers: { "x-codex-control-token": "gemini-fixture-control", origin: "https://foreign.example" } })).status, 403);
    // Node fetch replaces Host; a raw HTTP request exercises the actual proxy boundary.
    const publicHostStatus = await new Promise((resolve, reject) => {
        const req = httpRequest(new URL("/daemon/oauth-diagnostics", base), { headers: { "x-codex-control-token": "gemini-fixture-control", host: "gemini.example.com" } }, res => { res.resume(); resolve(res.statusCode); });
        req.on("error", reject); req.end();
    });
    assert.equal(publicHostStatus, 403);
});
