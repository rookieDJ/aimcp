import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OAuthDiagnostics, describeOAuthDiagnostics, noteOAuthTokenRequest, noteOAuthError } from "../dist/auth/diagnostics.js";
import { sanitizeRuntimeLogFields } from "../dist/lib/runtime-log.js";

test("OAuth observations are bounded, detached, secret-free and distinguish approval from redirect rejection", () => {
    const diagnostics = new OAuthDiagnostics();
    assert.match(describeOAuthDiagnostics(diagnostics.snapshot()), /尚未收到/);
    const secret = "fixture-sensitive-url-body-header";
    const observe = (path, status, location, aborted = false) => {
        const req = { url: path, method: "POST", headers: { "user-agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18.0 Safari/605.1.15 ${secret}`, authorization: secret, cookie: secret }, body: { password: secret } };
        const res = Object.assign(new EventEmitter(), { statusCode: status, writableFinished: !aborted, getHeader: () => location });
        diagnostics.observe(req, res);
        res.emit(aborted ? "close" : "finish"); res.emit("close");
    };
    observe(`/authorize?state=${secret}`, 302, `https://oauth-redirect.googleusercontent.com/r/${secret}?code=${secret}&state=${secret}`);
    observe("/authorize", 302, `https://oauth-redirect.googleusercontent.com/r/${secret}?error=invalid_scope&state=${secret}`);
    observe("/token", 500);
    observe("/token", 200, undefined, true);
    assert.deepEqual(diagnostics.snapshot().events.map(event => event.outcome), ["approved", "rejected", "rejected", "aborted"]);
    assert.equal(JSON.stringify(diagnostics.snapshot()).includes(secret), false);
    assert.match(describeOAuthDiagnostics(diagnostics.snapshot()), /已拒绝/);
    const detached = diagnostics.snapshot(); detached.events[0].status = 500; detached.events.pop();
    assert.equal(diagnostics.snapshot().events[0].status, 302);
    assert.equal(diagnostics.snapshot().events.length, 4);
    observe(`/unknown/${secret}`, 200);
    assert.equal(diagnostics.snapshot().events.length, 4);
    for (let i = 0; i < 70; i++) observe("/mcp", 401);
    assert.equal(diagnostics.snapshot().events.length, 64);
    assert.ok(diagnostics.snapshot().events.every(event => event.endpoint === "mcp"));
    assert.ok(diagnostics.snapshot().events.every(event => event.outcome === "challenge"));
    assert.match(describeOAuthDiagnostics(diagnostics.snapshot()), /需要授权/);
    assert.deepEqual(sanitizeRuntimeLogFields({ endpoint: "token", platform: "macos", browser: "safari", outcome: "approved", password: secret, url: secret, userAgent: secret }), { endpoint: "token", platform: "macos", browser: "safari", outcome: "approved" });
    assert.deepEqual(sanitizeRuntimeLogFields({ endpoint: secret, platform: secret, browser: secret, outcome: secret }), {});
});

test("token diagnostics retain only grant category, resource presence and allowlisted errors", () => {
    const diagnostics = new OAuthDiagnostics();
    const secret = "fixture-token-client-url-password";
    const observe = (grant, resource, code) => {
        const req = { url: "/token", method: "POST", headers: {}, body: { refresh_token: secret } };
        const res = Object.assign(new EventEmitter(), { statusCode: 400, writableFinished: true, getHeader: () => undefined });
        diagnostics.observe(req, res);
        noteOAuthTokenRequest(res, grant, resource);
        noteOAuthError(res, code);
        res.emit("finish");
    };
    observe("refresh_token", undefined, "invalid_grant");
    observe(secret, secret, secret);
    const events = diagnostics.snapshot().events;
    assert.equal(events[0].grantKind, "refresh_token");
    assert.equal(events[0].resourceProvided, false);
    assert.equal(events[0].oauthErrorCode, "invalid_grant");
    assert.equal(events[1].grantKind, "other");
    assert.equal(events[1].resourceProvided, true);
    assert.equal(events[1].oauthErrorCode, undefined);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.match(describeOAuthDiagnostics(diagnostics.snapshot()), /续期.*invalid_grant/);
    assert.deepEqual(sanitizeRuntimeLogFields({ grantKind: "refresh_token", resourceProvided: false, oauthErrorCode: "invalid_grant" }), { grantKind: "refresh_token", resourceProvided: false, oauthErrorCode: "invalid_grant" });
    assert.deepEqual(sanitizeRuntimeLogFields({ grantKind: secret, oauthErrorCode: secret }), {});
});
