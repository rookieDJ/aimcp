import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { request as httpRequest } from "node:http";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
const home = mkdtempSync(join(tmpdir(), "aimcp-oauth-network-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const { OAuthStateStore } = await import("../dist/auth/oauth-state.js");
const { CodexClientsStore, CodexOAuthProvider } = await import("../dist/auth/provider.js");
const { PrivateKeyJwtVerifier } = await import("../dist/auth/private-key-jwt.js");
const { OAuthRemoteUnavailableError } = await import("../dist/auth/remote-fetch.js");
const { createTokenEndpoint } = await import("../dist/auth/endpoints.js");
const { setAdminPassword, getAdminCredentialGeneration } = await import("../dist/auth/password-store.js");
const resource = new URL("https://fixture.example/mcp"), issuer = new URL("/", resource);
const clientId = "https://client.example/metadata";
const client = { client_id: clientId, client_name: "Network fixture", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" };
const response = (data, status = 200) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(data)) });

test("metadata outages are retryable service failures, not invalid clients; reconnect preserves the grant", async t => {
    await setAdminPassword("network-fixture-password-123!");
    const store = await OAuthStateStore.open(join(home, "oauth.json"));
    const generation = await getAdminCredentialGeneration();
    const grant = { clientId, redirectUri: client.redirect_uris[0], codeChallenge: "fixture", scopes: ["mcp:tools"], resource, credentialGeneration: generation };
    const tokens = await store.exchangeAuthorizationCode({ ...grant, code: await store.createAuthorizationCode(grant) });
    let offline = true;
    const fetcher = async () => { if (offline) throw Object.assign(new Error("fixture unavailable"), { code: "ENETUNREACH" }); return response(client); };
    const provider = new CodexOAuthProvider(store, issuer, resource, { fetch: fetcher });
    const app = express(); app.use("/token", createTokenEndpoint(provider));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const refresh = () => fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }) });
    const failed = await refresh();
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, "server_error");
    assert.ok(failed.headers.get("retry-after"));
    await store.verifyAccessToken(tokens.access_token, generation);
    offline = false;
    const retried = await refresh(); assert.equal(retried.status, 200);
    const rotated = await retried.json(); await provider.verifyAccessToken(rotated.access_token);
    // A connection lost before the exchange commits must not consume the current refresh token.
    let releaseMetadata, metadataStarted, exchangeDone;
    const pendingMetadata = new Promise(resolve => { releaseMetadata = resolve; });
    const started = new Promise(resolve => { metadataStarted = resolve; });
    const exchanged = new Promise(resolve => { exchangeDone = resolve; });
    const pendingProvider = new CodexOAuthProvider(store, issuer, resource, { fetch: async () => { metadataStarted(); await pendingMetadata; return response(client); } });
    const originalExchange = pendingProvider.exchangeRefreshToken.bind(pendingProvider);
    pendingProvider.exchangeRefreshToken = async (...args) => { try { return await originalExchange(...args); } finally { exchangeDone(args[4]?.aborted); } };
    let responseClosed;
    const closed = new Promise(resolve => { responseClosed = resolve; });
    const pendingApp = express();
    pendingApp.use((req, res, next) => { res.once("close", responseClosed); next(); });
    pendingApp.use("/token", createTokenEndpoint(pendingProvider));
    const pendingServer = pendingApp.listen(0, "127.0.0.1");
    await new Promise(resolve => pendingServer.once("listening", resolve));
    t.after(async () => { releaseMetadata(); await new Promise(resolve => pendingServer.close(resolve)); });
    const disconnected = httpRequest(`http://127.0.0.1:${pendingServer.address().port}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
    disconnected.on("error", () => {});
    disconnected.end(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: rotated.refresh_token }).toString());
    await started; disconnected.destroy(); await closed; releaseMetadata();
    assert.equal(await exchanged, true);
    await provider.verifyAccessToken(rotated.access_token);
    const afterDisconnect = await provider.exchangeRefreshToken(client, rotated.refresh_token);
    await provider.verifyAccessToken(afterDisconnect.access_token);
    assert.equal((await refresh()).status, 400); // Replay is still rejected, even after network recovery.
    await assert.rejects(provider.verifyAccessToken(rotated.access_token));
    const registered = { ...client, client_id: "registered-network-fixture" };
    await store.registerClient(registered, issuer.href);
    const localGrant = { ...grant, clientId: registered.client_id };
    const localTokens = await store.exchangeAuthorizationCode({ ...localGrant, code: await store.createAuthorizationCode(localGrant) });
    const reopened = await OAuthStateStore.open(join(home, "oauth.json"));
    const localProvider = new CodexOAuthProvider(reopened, issuer, resource, { fetch: async () => { throw new Error("Local registered client must not depend on the network"); } });
    await localProvider.verifyAccessToken(localTokens.access_token);
    const localClient = await localProvider.authenticateClient({ client_id: registered.client_id });
    const localRefreshed = await localProvider.exchangeRefreshToken(localClient, localTokens.refresh_token);
    await localProvider.verifyAccessToken(localRefreshed.access_token);
});

test("metadata and JWKS distinguish upstream outages from invalid documents and signatures", async t => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "aimcp-auth-fetch-"));
    t.after(() => rmSync(fixtureHome, { recursive: true, force: true }));
    const store = await OAuthStateStore.open(join(fixtureHome, "oauth.json"));
    for (const status of [408, 429, 500, 503]) {
        const clients = new CodexClientsStore(store, issuer, { fetch: async () => response({}, status) });
        await assert.rejects(clients.getClient(clientId), /temporarily unavailable/i);
    }
    const invalid = new CodexClientsStore(store, issuer, { fetch: async () => response({}) });
    assert.equal(await invalid.getClient(clientId), undefined);
    const missing = new CodexClientsStore(store, issuer, { fetch: async () => response({}, 404) });
    assert.equal(await missing.getClient(clientId), undefined);
    for (const failure of [Object.assign(new Error("fixture"), { code: "ENETDOWN" }), new Error("wrapper", { cause: Object.assign(new Error("fixture"), { code: "EAI_AGAIN" }) }), new Error("DNS-over-HTTPS timed out after 15000ms")]) {
        const clients = new CodexClientsStore(store, issuer, { fetch: async () => { throw failure; } });
        await assert.rejects(clients.getClient(clientId), OAuthRemoteUnavailableError);
    }
    const blocked = new CodexClientsStore(store, issuer, { fetch: async () => { throw new Error("URL resolves to a private address"); } });
    assert.equal(await blocked.getClient(clientId), undefined);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" };
    const signed = { ...client, token_endpoint_auth_method: "private_key_jwt", jwks_uri: "https://client.example/jwks" };
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer(clientId).setSubject(clientId).setAudience(new URL("/token", issuer).href).setIssuedAt().setExpirationTime("2m").setJti("fixture-jti").sign(privateKey);
    let offline = true;
    const verifier = new PrivateKeyJwtVerifier(issuer, { fetch: async () => offline ? response({}, 503) : response({ keys: [jwk] }) });
    await assert.rejects(verifier.verify(signed, assertion), /temporarily unavailable/i);
    offline = false;
    await verifier.verify(signed, assertion); // A failed download did not consume the assertion.
    await assert.rejects(verifier.verify(signed, assertion), /replay/);
    offline = true;
    const provider = new CodexOAuthProvider(store, issuer, resource, { fetch: async url => url.pathname === "/metadata" ? response(signed) : offline ? response({}, 503) : response({ keys: [jwk] }) });
    const authentication = { client_id: clientId, client_assertion: assertion, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" };
    await assert.rejects(provider.authenticateClient(authentication), /temporarily unavailable/i);
    offline = false;
    await provider.authenticateClient(authentication);
    await assert.rejects(provider.authenticateClient(authentication), /Invalid client/);
});
