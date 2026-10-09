import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const home = mkdtempSync(join(tmpdir(), 'aimcp-legacy-lifecycle-'));
process.env.HOME = home; process.env.USERPROFILE = home;
const old = join(home, '.codex-mcp'); mkdirSync(old);
const { stopLegacyInstallation } = await import('../dist/config/storage-lifecycle.js');
const { migrateLegacyUserData } = await import('../dist/config/storage-migration.js');
async function controller(t, mismatched = false) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import http from 'node:http'; const server=http.createServer((req,res)=>{if(req.headers['x-codex-controller-token']!=='fixture-token-01234567890123456789'){res.writeHead(401);res.end('{}');return;} process.send({path:req.url});res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,apiVersion:1,pid:process.pid+${mismatched ? '1' : '0'}}));if(req.url==='/api/controller/shutdown')setTimeout(()=>process.exit(0),30);});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));`], { stdio: ['ignore','ignore','ignore','ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const [message] = await once(child, 'message'); const paths = []; child.on('message', m => { if (m.path) paths.push(m.path); });
    writeFileSync(join(old, 'controller.json'), JSON.stringify({ schemaVersion: 1, apiVersion: 1, pid: child.pid, host: '127.0.0.1', port: message.port, controlToken: 'fixture-token-01234567890123456789', version: '1.2.3', startedAt: new Date().toISOString() }));
    return { child, paths };
}
test('upgraded stop keeps legacy Controller online; shutdown verifies identity before migration', async t => {
    const { child, paths } = await controller(t);
    assert.equal(await stopLegacyInstallation('open'), false);
    assert.throws(() => migrateLegacyUserData(home), /shutdown/);
    assert.equal(await stopLegacyInstallation('stop'), true); assert.ok(paths.includes('/api/runtime/stop')); assert.equal(child.exitCode, null); assert.equal(existsSync(join(home, '.ai-mcp')), false);
    assert.equal(await stopLegacyInstallation('shutdown'), true); assert.ok(paths.includes('/api/controller/shutdown'));
    assert.equal(migrateLegacyUserData(home), true); assert.equal(existsSync(join(home, '.ai-mcp/controller.json')), false);
    rmSync(join(home, '.ai-mcp'), { recursive: true }); rmSync(join(old, 'controller.json'));
});
test('legacy process with mismatched control identity is never stopped', async t => {
    const { paths } = await controller(t, true);
    await assert.rejects(stopLegacyInstallation('shutdown'), /身份不一致/);
    assert.deepEqual(paths, ['/api/controller/status']); assert.equal(existsSync(join(home, '.ai-mcp')), false);
});
test.after(() => rmSync(home, { recursive: true, force: true }));
