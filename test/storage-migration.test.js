import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { migrateLegacyUserData } = await import('../dist/config/storage-migration.js');
function fixture(t) { const home = mkdtempSync(join(tmpdir(), 'aimcp-migration-')); t.after(() => rmSync(home, { recursive: true, force: true })); const old = join(home, '.codex-mcp'); mkdirSync(old, { mode: 0o700 }); return { home, old, next: join(home, '.ai-mcp') }; }
test('migration preserves private data and identities, rebases only managed paths, and is idempotent', t => {
    const { home, old, next } = fixture(t);
    mkdirSync(join(old, 'tunnel-configs')); mkdirSync(join(old, 'conversations')); mkdirSync(join(old, 'bin'));
    writeFileSync(join(old, 'config.json'), JSON.stringify({ publicAccess: { kind: "cloudflare", domain: "fixture.example.com", cloudflaredBin: join(old, 'bin/cloudflared'), tunnelName: "fixture", tunnelId: "12345678-1234-1234-1234-123456789abc", configRevision: "fixture00", accountId: "a".repeat(32), zoneId: "b".repeat(32) } }));
    writeFileSync(join(old, 'bin/cloudflared'), 'fixture', { mode: 0o700 });
    writeFileSync(join(old, 'tunnel-configs/a.yml'), `credentials-file: "${old}/tunnel-credentials/id.json"\ningress: []\n`);
    writeFileSync(join(old, 'oauth-state.json'), 'identity-fixture'); writeFileSync(join(old, 'conversations/chat.json'), 'chat-fixture');
    writeFileSync(join(old, 'projects.json'), JSON.stringify({ path: join(old, 'custom-project') }));
    assert.equal(migrateLegacyUserData(home), true);
    assert.equal(readFileSync(join(next, 'oauth-state.json'), 'utf8'), 'identity-fixture');
    assert.equal(readFileSync(join(old, 'conversations/chat.json'), 'utf8'), 'chat-fixture');
    assert.equal(JSON.parse(readFileSync(join(next, 'config.json'))).publicAccess.cloudflaredBin, join(next, 'bin/cloudflared'));
    assert.ok(readFileSync(join(next, 'tunnel-configs/a.yml'), 'utf8').includes(next));
    assert.ok(readFileSync(join(next, 'projects.json'), 'utf8').includes(old));
    if (process.platform !== 'win32') { assert.equal(statSync(next).mode & 0o777, 0o700); assert.equal(statSync(join(next, 'conversations/chat.json')).mode & 0o777, 0o600); assert.equal(statSync(join(next, 'bin/cloudflared')).mode & 0o777, 0o700); }
    assert.equal(migrateLegacyUserData(home), false);
});
test('migration refuses active process, configuration conflicts and linked private files without partial state', t => {
    const { home, old, next } = fixture(t); writeFileSync(join(old, 'config.json'), '{}');
    writeFileSync(join(old, 'daemon.json'), JSON.stringify({ pid: process.pid }));
    assert.throws(() => migrateLegacyUserData(home), /shutdown/); assert.equal(existsSync(next), false);
    rmSync(join(old, 'daemon.json')); mkdirSync(next); writeFileSync(join(next, 'config.json'), '{"port":4000}');
    assert.throws(() => migrateLegacyUserData(home), /覆盖/); assert.equal(readFileSync(join(next, 'config.json'), 'utf8'), '{"port":4000}');
    rmSync(next, { recursive: true }); writeFileSync(join(home, 'private'), 'external'); symlinkSync(join(home, 'private'), join(old, 'oauth-state.json'));
    assert.throws(() => migrateLegacyUserData(home), /普通文件|链接/); assert.equal(existsSync(next), false);
});
test('fresh installation prefix is retained while old state migrates; npm backup is not copied', t => {
    const { home, old, next } = fixture(t); writeFileSync(join(old, 'config.json'), '{}'); mkdirSync(join(old, 'npm')); writeFileSync(join(old, 'npm/old'), 'old');
    mkdirSync(join(next, 'npm'), { recursive: true }); writeFileSync(join(next, 'npm/new'), 'new');
    assert.equal(migrateLegacyUserData(home), true); assert.equal(readFileSync(join(next, 'npm/new'), 'utf8'), 'new'); assert.equal(existsSync(join(next, 'npm/old')), false);
});
test('invalid legacy schema and concurrent migration lock preserve the original bytes', t => {
    const { home, old, next } = fixture(t);
    const content = '{"domain":"unsupported.example.com"}'; writeFileSync(join(old, 'config.json'), content);
    assert.throws(() => migrateLegacyUserData(home), /不受支持/); assert.equal(readFileSync(join(old, 'config.json'), 'utf8'), content); assert.equal(existsSync(next), false);
    writeFileSync(join(home, '.ai-mcp-migration.lock'), 'fixture');
    assert.throws(() => migrateLegacyUserData(home), /迁移操作/); assert.equal(readFileSync(join(home, '.ai-mcp-migration.lock'), 'utf8'), 'fixture');
});
