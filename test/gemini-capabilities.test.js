import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { geminiCapabilityProvider: provider } = await import('../dist/capabilities/providers/gemini.js');
const { SkillRegistry } = await import('../dist/skills/registry.js');
function fixture(t) { const home = mkdtempSync(join(tmpdir(), 'aimcp-gemini-')); t.after(() => rmSync(home, { recursive: true, force: true })); const workspace = join(home, 'project'); mkdirSync(join(home, '.gemini'), { recursive: true }); mkdirSync(join(workspace, '.gemini'), { recursive: true }); return { home, workspace, context: { homeDirectory: home, primaryWorkspace: workspace, workspaceRoots: [workspace], includeUserScope: true, includeProjectScope: true } }; }
function json(path, value) { writeFileSync(path, JSON.stringify(value)); }
test('Gemini imports real stdio and streamable HTTP settings, project precedence and persistent disablement', async t => {
    const { home, workspace, context } = fixture(t);
    json(join(home, '.gemini/settings.json'), { mcpServers: { global: { command: 'node', args: ['a.js'] }, shared: { command: 'user' }, blocked: { command: 'blocked' }, disabled: { command: 'disabled' } }, mcp: { excluded: ['BLOCKED'] } });
    json(join(workspace, '.gemini/settings.json'), { mcpServers: { shared: { command: 'project' }, remote: { httpUrl: 'https://example.com/mcp', timeout: 1234 } } });
    json(join(home, '.gemini/mcp-server-enablement.json'), { disabled: { enabled: false } });
    let result = await provider.loadMcp(context); assert.deepEqual(Object.keys(result.config.mcpServers).sort(), ['global','remote','shared']);
    assert.equal(result.config.mcpServers.shared.command, 'project'); assert.equal(result.config.mcpServers.global.cwd, home); assert.equal(result.config.mcpServers.remote.toolTimeoutMs, 1234);
    result = await provider.loadMcp({ ...context, includeProjectScope: false }); assert.equal(result.config.mcpServers.shared.command, 'user'); assert.equal(result.config.mcpServers.remote, undefined);
    result = await provider.loadMcp({ ...context, includeUserScope: false }); assert.equal(result.config.mcpServers.global, undefined); assert.equal(result.config.mcpServers.shared.cwd, workspace);
    json(join(workspace, '.gemini/settings.json'), { mcp: { allowed: [] }, mcpServers: { remote: { httpUrl: 'https://example.com/mcp' } } });
    assert.deepEqual((await provider.loadMcp(context)).config.mcpServers, {});
});
test('Gemini refuses unsupported permissions/authentication and fails closed on corrupt enablement', async t => {
    const { home, context } = fixture(t);
    json(join(home, '.gemini/settings.json'), { mcpServers: { sse: { url: 'https://example.com/sse' }, auth: { httpUrl: 'https://example.com', oauth: { enabled: true } }, filtered: { command: 'node', includeTools: ['safe'] }, self: { command: 'aimcp' }, safe: { command: 'node' } } });
    let result = await provider.loadMcp(context); assert.deepEqual(Object.keys(result.config.mcpServers), ['safe']); assert.equal(result.warnings.length, 4);
    writeFileSync(join(home, '.gemini/mcp-server-enablement.json'), '{'); result = await provider.loadMcp(context); assert.deepEqual(result.config.mcpServers, {}); assert.ok(result.warnings.length);
});
test('Gemini skills honor project precedence, disabled names, enabled toggle and watch targets', t => {
    const { home, workspace, context } = fixture(t);
    for (const [root, text] of [[home, 'user'], [workspace, 'project']]) for (const name of ['same','disabled']) { const dir = join(root, '.gemini/skills', name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${text}\n---\n${text}`); }
    json(join(home, '.gemini/settings.json'), { skills: { disabled: ['disabled'] } });
    const registry = SkillRegistry.discover(provider.skillRoots(context)); assert.deepEqual(registry.list().map(s => s.name), ['same']); assert.equal(registry.list()[0].description, 'project'); assert.equal(registry.list()[0].source, 'gemini');
    assert.ok(provider.watchTargets(context).some(t => t.fileName === 'mcp-server-enablement.json')); assert.ok(provider.watchTargets(context).some(t => t.directory === join(workspace, '.gemini/skills')));
    json(join(home, '.gemini/settings.json'), { skills: { enabled: false } }); assert.deepEqual(provider.skillRoots(context), []);
});
test('Gemini JSONC, environment values, system policy and project skill disabling are respected', async t => {
    const { home, workspace, context } = fixture(t);
    const oldSystem = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH; const oldEnv = process.env.AIMCP_GEMINI_FIXTURE;
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(home, 'system.json'); process.env.AIMCP_GEMINI_FIXTURE = 'fixture';
    t.after(() => { if (oldSystem === undefined) delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH; else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH=oldSystem; if (oldEnv === undefined) delete process.env.AIMCP_GEMINI_FIXTURE; else process.env.AIMCP_GEMINI_FIXTURE=oldEnv; });
    writeFileSync(join(home, '.gemini/settings.json'), '{ // configuration\n "mcpServers": { "env": { "command": "node", "args": ["$AIMCP_GEMINI_FIXTURE"], }, }, }');
    let result = await provider.loadMcp(context); assert.deepEqual(result.config.mcpServers.env.args, ['fixture']);
    json(join(home, 'system.json'), { admin: { mcp: { enabled: false } } }); assert.deepEqual((await provider.loadMcp(context)).config.mcpServers, {});
    json(join(home, 'system.json'), {}); json(join(workspace, '.gemini/settings.json'), { policyPaths: ['policy.toml'] }); assert.deepEqual((await provider.loadMcp(context)).config.mcpServers, {});
    const dir = join(home, '.gemini/skills/disabled'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), '---\nname: disabled\n---\nfixture');
    json(join(workspace, '.gemini/settings.json'), { skills: { disabled: ['disabled'] } }); assert.deepEqual(SkillRegistry.discover(provider.skillRoots(context)).list(), []);
});
