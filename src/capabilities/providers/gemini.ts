import { parse, type ParseError } from "jsonc-parser";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { normalizeMcpServerEntry, type McpServerConfig } from "../../config/user-mcp.js";
import type { SkillRoot } from "../../skills/registry.js";
import type { CapabilityContext, CapabilityProvider } from "../provider.js";

type JsonObject = Record<string, unknown>;

/** File-based Gemini CLI capabilities. No CLI login or OAuth token cache is read. */
export const geminiCapabilityProvider: CapabilityProvider = {
    id: "gemini", label: "Gemini CLI", supportsMcp: true, supportsSkills: true,
    async detect(context) {
        const paths = scopePaths(context);
        const mcp = paths.some(({ root }) => existsSync(join(root, ".gemini", "settings.json")));
        const skills = paths.some(({ root }) => existsSync(join(root, ".gemini", "skills")));
        return { source: "gemini", label: "Gemini CLI", detected: mcp || skills, mcp, skills, ...(mcp || skills ? { detail: "Gemini settings / skills" } : {}) };
    },
    async loadMcp(context) {
        const warnings: string[] = [];
        const mcpServers: Record<string, McpServerConfig> = {};
        try {
            const global = readSettings(join(context.homeDirectory, ".gemini", "settings.json"));
            const system = readSettings(systemPath());
            const defaults = readSettings(defaultsPath());
            const enablement = readSettings(join(context.homeDirectory, ".gemini", "mcp-server-enablement.json"));
            for (const state of Object.values(enablement)) {
                if (typeof object(state).enabled !== "boolean") throw new Error("Gemini MCP 停用记录格式无效");
            }
            const user = context.includeUserScope ? object(global.mcpServers) : {};
            const scopes = context.includeProjectScope && context.workspaceRoots.length ? context.workspaceRoots : [undefined];
            for (const [index, workspace] of scopes.entries()) {
                const local = workspace ? readSettings(join(workspace, ".gemini", "settings.json")) : {};
                const policy = mergeSettings(defaults, global, local, system);
                if ([defaults, global, local, system].some(settings => settings.policyPaths !== undefined || settings.adminPolicyPaths !== undefined)) throw new Error("独立 Gemini 策略无法导入");
                if (object(object(policy.admin).mcp).enabled === false) continue;
                // Respect system overrides of the same server, while importing only requested scopes.
                const servers = { ...user, ...object(local.mcpServers) };
                const systemServers = object(system.mcpServers);
                const allowed = stringList(object(policy.mcp).allowed);
                const excluded = stringList(object(policy.mcp).excluded) ?? [];
                for (const [name, entry] of Object.entries(servers)) {
                    const id = name.trim().toLowerCase();
                    if ((allowed && !allowed.map(n => n.trim().toLowerCase()).includes(id)) || excluded.some(n => n.trim().toLowerCase() === id) || object(enablement[id]).enabled === false) continue;
                    try {
                        const raw = object(systemServers[name] ?? entry);
                        const server = normalizeServer(name, raw, workspace && Object.hasOwn(object(local.mcpServers), name) ? workspace : context.homeDirectory);
                        const qualified = index > 0 ? `${workspaceLabel(workspace!)}_${name}` : name;
                        mcpServers[qualified] = server;
                    } catch (error) { warnings.push(error instanceof Error ? error.message : "Gemini MCP 配置无法导入"); }
                }
            }
        } catch {
            // Never retain a previous configuration when the enablement/policy file is unreadable.
            return { config: { mcpServers: {} }, warnings: ["Gemini 配置或停用记录无法读取，已停止导入；请检查 settings.json / mcp-server-enablement.json。"] };
        }
        return { config: { mcpServers }, ...(warnings.length ? { warnings } : {}) };
    },
    skillRoots(context) {
        try {
            const global = readSettings(join(context.homeDirectory, ".gemini", "settings.json"));
            const system = readSettings(systemPath());
            const defaults = readSettings(defaultsPath());
            const roots: SkillRoot[] = [];
            // Higher precedence project skills must be discovered before user skills.
            for (const { root, scope, index } of [...scopePaths(context)].reverse()) {
                const local = scope === "project" ? readSettings(join(root, ".gemini", "settings.json")) : context.includeProjectScope ? readSettings(join(context.primaryWorkspace, ".gemini", "settings.json")) : {};
                const policy = mergeSettings(defaults, global, local, system);
                if (object(policy.skills).enabled === false || object(object(policy.admin).skills).enabled === false) continue;
                const disabledNames = stringList(object(policy.skills).disabled) ?? [];
                roots.push({ path: join(root, ".gemini", "skills"), source: "gemini", scope, disabledNames, respectModelInvocation: true, ...(scope === "project" ? { workspaceRoot: root } : {}), ...(index > 0 ? { namePrefix: `${workspaceLabel(root)}:` } : {}) });
            }
            return roots;
        } catch { return []; }
    },
    watchTargets(context) {
        const paths = scopePaths(context);
        return [
            ...paths.flatMap(({ root }) => [
                { key: `gemini-settings-${root}`, directory: join(root, ".gemini"), fileName: "settings.json", recursiveWhenExact: false, kind: "both" as const },
                { key: `gemini-skills-${root}`, directory: join(root, ".gemini", "skills"), recursiveWhenExact: true, kind: "skills" as const },
            ]),
            // Global policies and enablement also apply to a manager exposing only project MCP.
            ...[join(context.homeDirectory, ".gemini", "settings.json"), join(context.homeDirectory, ".gemini", "mcp-server-enablement.json"), systemPath(), defaultsPath()].map(path => ({ key: `gemini-policy-${path}`, directory: dirname(path), fileName: basename(path), recursiveWhenExact: false, kind: "both" as const })),
        ];
    },
};

function normalizeServer(name: string, raw: JsonObject, cwd: string): McpServerConfig {
    for (const field of ["oauth", "authProviderType", "targetAudience", "includeTools", "excludeTools", "tcp", "extension"]) {
        if (raw[field] !== undefined) throw new Error(`Gemini MCP ${name} 使用暂不支持的 ${field}，已跳过，避免改变权限或认证方式。`);
    }
    if (raw.type === "sse" || (raw.url !== undefined && raw.type !== "http")) throw new Error(`Gemini MCP ${name} 使用暂不支持的 SSE，已跳过。`);
    if (raw.type !== undefined && !["stdio", "http"].includes(String(raw.type))) throw new Error(`Gemini MCP ${name} 的传输类型无效。`);
    if (raw.type === "stdio" && (raw.httpUrl !== undefined || raw.url !== undefined)) throw new Error(`Gemini MCP ${name} 的传输配置冲突。`);
    if (raw.type === "http" && raw.httpUrl === undefined && raw.url === undefined) throw new Error(`Gemini MCP ${name} 缺少 HTTP 地址。`);
    if (["aimcp", "codex-mcp"].includes(name.toLowerCase()) || (Array.isArray(raw.args) && raw.args.some(arg => typeof arg === "string" && /^@rookiedj\/aimcp(?:@.*)?$/.test(arg)))) throw new Error(`Gemini MCP ${name} 指向 aimcp 自身，已跳过。`);
    if (typeof raw.command === "string" && /(?:^|[\\/])aimcp(?:\.cmd|\.exe)?$/i.test(raw.command)) throw new Error(`Gemini MCP ${name} 指向 aimcp 自身，已跳过。`);
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== "string"))) throw new Error(`Gemini MCP ${name} 的 args 无效。`);
    const config = normalizeMcpServerEntry(name, { ...raw, ...(raw.httpUrl !== undefined || raw.type === "http" ? { url: raw.httpUrl ?? raw.url } : {}), ...(raw.command ? { cwd: typeof raw.cwd === "string" ? resolve(cwd, raw.cwd) : cwd } : {}) }, false);
    if (raw.timeout !== undefined) {
        if (typeof raw.timeout !== "number" || !Number.isFinite(raw.timeout) || raw.timeout <= 0) throw new Error(`Gemini MCP ${name} 的 timeout 无效。`);
        config.startupTimeoutMs = raw.timeout; config.toolTimeoutMs = raw.timeout;
    }
    return config;
}
function scopePaths(context: CapabilityContext): { root: string; scope: "user" | "project"; index: number }[] {
    return [...(context.includeUserScope ? [{ root: context.homeDirectory, scope: "user" as const, index: 0 }] : []), ...(context.includeProjectScope ? context.workspaceRoots.map((root, index) => ({ root, scope: "project" as const, index })) : [])];
}
function systemPath(): string {
    return process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? (process.platform === "darwin" ? "/Library/Application Support/GeminiCli/settings.json" : process.platform === "win32" ? "C:\\ProgramData\\gemini-cli\\settings.json" : "/etc/gemini-cli/settings.json");
}
function defaultsPath(): string { return process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? join(dirname(systemPath()), "system-defaults.json"); }
function object(value: unknown): JsonObject { if (value === undefined) return {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Gemini object"); return value as JsonObject; }
function readSettings(path: string): JsonObject {
    if (!existsSync(path)) return {};
    const errors: ParseError[] = [];
    const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error("Invalid Gemini JSON config");
    return object(expand(value));
}
function stringList(value: unknown): string[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value) || value.some(n => typeof n !== "string")) throw new Error("Invalid Gemini list"); return value; }
function mergeSettings(...layers: JsonObject[]): JsonObject {
    const merged: JsonObject = {};
    for (const layer of layers) for (const key of ["mcp", "skills", "admin"]) {
        const previous = object(merged[key]); const next = object(layer[key]);
        merged[key] = { ...previous, ...next, ...(key === "skills" ? { disabled: [...new Set([...(stringList(previous.disabled) ?? []), ...(stringList(next.disabled) ?? [])])] } : {}) };
    }
    return merged;
}
function expand(value: unknown): unknown {
    if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, a: string, b: string) => {
        const resolved = process.env[a ?? b]; if (resolved === undefined) throw new Error("Gemini MCP 引用了未设置的环境变量。"); return resolved;
    });
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
    return value;
}
function workspaceLabel(root: string): string { return `${basename(root).replace(/[^A-Za-z0-9_-]/g, "-")}-${createHash("sha1").update(resolve(root)).digest("hex").slice(0, 6)}`; }
