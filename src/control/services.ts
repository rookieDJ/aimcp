import { resolve } from "node:path";
export { inspectGeminiCompression, configureGeminiCompression } from "../config/gemini-compression.js";
import { bindingPresentationId, presentBindings, validateProjectFolder } from "./project-selection.js";
import { generateAdminPassword, hasAdminPassword, setAdminPassword, verifyAdminPassword } from "../auth/password-store.js";
import { CapabilityManager } from "../capabilities/manager.js";
import { resolveCapabilitiesConfig } from "../capabilities/config.js";
import { ensureUserConfigDirs, isConversationRecordingEnabled, loadUserConfig, saveUserConfig, type UserCapabilitiesConfig } from "../config/user-config.js";
import {
    cleanStaleDaemonState,
    contactRunningDaemon,
    startDaemonForIntent,
    stopDaemonContact,
    withDaemonLifecycleLock,
} from "../daemon/control.js";
import {
    loadBindingsFile,
    loadProjectsFile,
    saveProjectsFile,
    type RegisteredProject,
    type RuntimeIntent,
    type SessionBinding,
} from "../daemon/state.js";
import { runDoctorChecks, type DoctorReport, type DoctorOptions } from "../doctor/index.js";
import { runSelfUpdate } from "../doctor/update.js";
import { findRipgrep } from "../lib/search/ripgrep.js";
import { ensureManagedTool } from "../managed-tools/install.js";
import { BindingStore } from "../projects/bindings.js";
import { archiveProjectBindings, deleteConversation, listConversationRecords, readConversation } from "../projects/conversations.js";
import { canonicalProjectPath, detectProjectDisplayName } from "../projects/identity.js";
import { ProjectRegistry } from "../projects/registry.js";
import { readRecentLogLines } from "../lib/log-reader.js";
import {
    discoverCloudflareSetup,
    loadCommittedTunnelSetup,
    prepareCloudflareTunnelSetup,
    prepareExternalTunnelSetup,
} from "../tunnel/setup.js";
import { checkPublicAccess, configurePreparedPublicAccess } from "../tunnel/public-access-manager.js";
import { suggestCloudflaredBin } from "../tunnel/bin.js";

export interface RuntimeStartInput extends RuntimeIntent {
    /** When false, an existing daemon keeps its current intent. Mirrors CLI start without explicit mode flags. */
    intentSpecified?: boolean;
    projectPath?: string;
}

export interface ControlStatus {
    running: boolean;
    runtime?: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof contactRunningDaemon>>>["client"]["status"]>>;
    projects: Array<RegisteredProject & { boundSessions?: number | null }>;
}

export interface DoctorServiceResult {
    fixes: string[];
    warnings: string[];
    report: DoctorReport;
}

export type PresentedConversation = ReturnType<typeof presentBindings>[number];

export interface ProjectConversationsResult {
    project?: RegisteredProject;
    conversations: PresentedConversation[];
}

export function getConversationHistory() {
    // Reads stay read-only; live legacy bindings are already persisted in routing state.
    return listConversationRecords(loadBindingsFile(), loadProjectsFile());
}

export function setConversationRecording(enabled: boolean): { enabled: boolean } {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    saveUserConfig({ saveConversations: enabled });
    return { enabled: isConversationRecordingEnabled() };
}

export async function deleteConversationHistory(id: string) {
    const binding = loadBindingsFile().find(item => bindingPresentationId(item.ownerKey) === id);
    return await deleteConversation(id, binding?.client ?? (binding?.ownerKey.includes("|openai-session:") ? "chatgpt" : "other"));
}

export function getConversationTranscript(id: string) {
    const record = readConversation(id);
    if (!record) throw new Error("此会话尚未收到客户端发送的聊天内容。");
    return record;
}

export interface CleanupProjectConversationsResult extends ProjectConversationsResult {
    removed: number;
}

export async function getControlStatus(): Promise<ControlStatus> {
    const daemon = await contactRunningDaemon();
    if (!daemon) {
        cleanStaleDaemonState();
        return {
            running: false,
            projects: loadProjectsFile().map((item) => ({ ...item, boundSessions: null })),
        };
    }
    const runtime = await daemon.client.status();
    return { running: true, runtime, projects: runtime.projects };
}

export async function startRuntime(input: RuntimeStartInput): Promise<ControlStatus> {
    const requested = canonicalRuntimeIntent({
        local: input.local,
        noTunnel: input.noTunnel,
        tunnelLogs: input.tunnelLogs,
    });
    const desired = input.intentSpecified === true
        ? requested
        : preferredRuntimeIntent(loadUserConfig());
    if (input.intentSpecified === true) persistRuntimeIntent(desired);
    const daemon = await ensureRuntime(desired, input.intentSpecified === true);
    if (input.intentSpecified !== true) persistRuntimeIntent(daemon.state.runtimeIntent);
    if (input.projectPath) {
        const projectPath = canonicalProjectPath(resolve(input.projectPath));
        await daemon.client.registerProject({ path: projectPath, name: detectProjectDisplayName(projectPath) });
    }
    return await getControlStatus();
}

export async function stopRuntime(): Promise<boolean> {
    return await withDaemonLifecycleLock(async () => {
        const daemon = await contactRunningDaemon();
        if (!daemon) {
            cleanStaleDaemonState();
            return false;
        }
        await stopDaemonContact(daemon);
        return true;
    });
}

export async function restartRuntime(): Promise<ControlStatus> {
    await withDaemonLifecycleLock(async () => {
        const existing = await contactRunningDaemon();
        if (!existing) {
            cleanStaleDaemonState();
            throw new Error("MCP Runtime 没有在运行，无法重启；请使用 `aimcp start`");
        }
        const intent = existing.state.runtimeIntent;
        await assertIntentReady(intent);
        await stopDaemonContact(existing);
        await startDaemonForIntent(intent);
    });
    return await getControlStatus();
}

export async function listProjects(): Promise<Array<RegisteredProject & { boundSessions?: number | null }>> {
    return (await getControlStatus()).projects;
}

export async function addProject(pathValue: string): Promise<RegisteredProject> {
    const projectPath = await validateProjectFolder(pathValue);
    return await withDaemonLifecycleLock(async () => {
        const daemon = await contactRunningDaemon();
        if (daemon) {
            return await daemon.client.registerProject({ path: projectPath, name: detectProjectDisplayName(projectPath) });
        }
        cleanStaleDaemonState();
        return await new ProjectRegistry().register({ path: projectPath, name: detectProjectDisplayName(projectPath) });
    });
}

export async function removeProject(target: string, options: { forget?: boolean } = {}): Promise<{ removed: boolean; project: RegisteredProject }> {
    return await withDaemonLifecycleLock(async () => {
        const daemon = await contactRunningDaemon();
        const status = daemon ? await daemon.client.status() : undefined;
        const projects = status?.projects ?? loadProjectsFile();
        const project = resolveProjectSelection(projects, target);
        if (!project) throw new Error(`没有找到项目：${target}`);
        await archiveProjectBindings(project, daemon ? await daemon.client.listProjectBindings(project.id) : loadBindingsFile());
        if (daemon) {
            const result = await daemon.client.deactivateProject(project.id, project.path, options.forget);
            return { removed: result.removed, project };
        }
        if (options.forget) {
            // Keep a retryable inactive registration until every cleanup/write succeeds.
            const inactive = projects.map((item) => item.id === project.id ? { ...item, active: false } : item);
            if (project.active) await saveProjectsFile(inactive);
            await new BindingStore().invalidateProject(project.id);
            await saveProjectsFile(inactive.filter((item) => item.id !== project.id));
            return { removed: true, project };
        }
        await new BindingStore().invalidateProject(project.id);
        if (!project.active) return { removed: false, project };
        await saveProjectsFile(projects.map((item) => item.id === project.id ? { ...item, active: false } : item));
        return { removed: true, project };
    });
}

export async function getProject(target: string): Promise<(RegisteredProject & { boundSessions?: number | null }) | undefined> {
    const projects = await listProjects();
    return resolveProjectSelection(projects, target);
}

export async function listProjectConversations(target?: string): Promise<ProjectConversationsResult> {
    if (!target) {
        return { conversations: presentBindings(loadBindingsFile()) };
    }
    const daemon = await contactRunningDaemon();
    const projects = daemon ? (await daemon.client.status()).projects : loadProjectsFile();
    const project = resolveProjectSelection(projects, target);
    if (!project) throw new Error(`没有找到项目：${target}`);
    const bindings = daemon
        ? await daemon.client.listProjectBindings(project.id)
        : loadBindingsFile().filter((item) => item.projectId === project.id);
    return { project, conversations: presentBindings(bindings) };
}

export async function cleanupProjectConversations(
    target: string,
    conversationIds: string[],
): Promise<CleanupProjectConversationsResult> {
    const requestedIds = new Set(conversationIds);
    if (
        conversationIds.length > 1_024 ||
        conversationIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))
    ) {
        throw new Error("会话编号列表无效");
    }
    return await withDaemonLifecycleLock(async () => {
        const daemon = await contactRunningDaemon();
        const projects = daemon ? (await daemon.client.status()).projects : loadProjectsFile();
        const project = resolveProjectSelection(projects, target);
        if (!project) throw new Error(`没有找到项目：${target}`);
        const bindings = daemon
            ? await daemon.client.listProjectBindings(project.id)
            : loadBindingsFile().filter((item) => item.projectId === project.id);
        const removeOwnerKeys = bindings
            .filter((binding) => requestedIds.has(bindingPresentationId(binding.ownerKey)))
            .map((binding) => binding.ownerKey);
        await archiveProjectBindings(project, bindings.filter(binding => removeOwnerKeys.includes(binding.ownerKey)));

        let removed = 0;
        let remaining: SessionBinding[];
        if (daemon) {
            const result = await daemon.client.cleanupProjectBindings(project.id, removeOwnerKeys);
            removed = result.removed;
            remaining = result.bindings;
        } else {
            const store = new BindingStore();
            removed = await store.removeFromProject(project.id, removeOwnerKeys);
            remaining = store.list().filter((item) => item.projectId === project.id);
        }
        return { project, removed, conversations: presentBindings(remaining) };
    });
}

export async function runDoctorService(fix = false, options: DoctorOptions = {}): Promise<DoctorServiceResult> {
    const fixes: string[] = [];
    const warnings: string[] = [];
    options.signal?.throwIfAborted();
    if (fix) {
        options.onPhase?.("恢复本机目录与依赖");
        ensureUserConfigDirs();
        fixes.push("已确保 ~/.ai-mcp 配置目录和日志目录存在");
        try {
            const state = (await import("../daemon/state.js")).loadDaemonState();
            const stale = Boolean(state && !isPidAlive(state.pid));
            cleanStaleDaemonState();
            if (stale) fixes.push("已清理失效的 daemon 状态文件");
        } catch { warnings.push("daemon 状态损坏，已保留原文件；请根据诊断结果修复。"); }
        if (!(await findRipgrep())) {
            try {
                const installed = await ensureManagedTool("ripgrep");
                fixes.push(`已安装文件搜索组件：${installed.path}`);
            } catch (error) {
                warnings.push(
                    `文件搜索组件自动恢复失败：${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        options.signal?.throwIfAborted();
        try {
            const config = loadUserConfig();
            if (config.publicAccess?.kind === "cloudflare") {
                if (!(await suggestCloudflaredBin(config.publicAccess.cloudflaredBin))) {
                    await ensureManagedTool("cloudflared");
                    fixes.push("已恢复受管 cloudflared 组件");
                }
                options.signal?.throwIfAborted();
                options.onPhase?.("检查并恢复本机托管隧道");
                await withDaemonLifecycleLock(async () => {
                    options.signal?.throwIfAborted();
                    const daemon = await contactRunningDaemon();
                    if (!daemon || daemon.state.runtimeIntent.local || daemon.state.runtimeIntent.noTunnel) return;
                    const status = await daemon.client.status();
                    if (status.tunnel.state === "connected") return;
                    // Validate the committed local identity; never guess resources or rewrite DNS.
                    await loadCommittedTunnelSetup(config, daemon.state.host, daemon.state.port);
                    if (status.publicMcpUrl !== `https://${config.publicAccess!.domain}/mcp`) throw new Error("运行地址与已保存配置不一致，请先重启服务");
                    options.signal?.throwIfAborted();
                    await daemon.client.recoverTunnel(options.signal);
                    fixes.push("已重连本机 Cloudflare 隧道，MCP 服务与项目会话保持在线");
                });
            }
        } catch (error) {
            options.signal?.throwIfAborted();
            warnings.push(`本机隧道恢复未完成：${error instanceof Error ? error.message : "请查看诊断结果"}`);
        }
    }
    return { fixes, warnings, report: await runDoctorChecks(options) };
}

export async function setConnectionPassword(password: string): Promise<void> {
    await setAdminPassword(password);
    if (!(await verifyAdminPassword(password))) throw new Error("连接密码保存后校验失败");
}

export async function generateConnectionPassword(): Promise<string> {
    const password = generateAdminPassword();
    await setConnectionPassword(password);
    return password;
}

export async function getConsoleSyncState(): Promise<{
    config: Pick<ReturnType<typeof loadUserConfig>, "publicAccess" | "runtime" | "saveConversations">;
    passwordConfigured: boolean;
}> {
    const config = loadUserConfig();
    return {
        config: {
            saveConversations: config.saveConversations === true,
            ...(config.publicAccess ? { publicAccess: config.publicAccess } : {}),
            ...(config.runtime ? { runtime: config.runtime } : {}),
        },
        passwordConfigured: await hasAdminPassword(),
    };
}

export async function getSetupSummary(primaryWorkspace = process.cwd()): Promise<{
    config: ReturnType<typeof loadUserConfig>;
    passwordConfigured: boolean;
    capabilities: ReturnType<typeof resolveCapabilitiesConfig>;
    detections: Awaited<ReturnType<CapabilityManager["detectSources"]>>;
}> {
    const config = loadUserConfig();
    const manager = new CapabilityManager(resolve(primaryWorkspace));
    return {
        config,
        passwordConfigured: await hasAdminPassword(),
        capabilities: resolveCapabilitiesConfig(config.capabilities),
        detections: await manager.detectSources(),
    };
}

export function saveCapabilities(config: UserCapabilitiesConfig): ReturnType<typeof resolveCapabilitiesConfig> {
    const saved = saveUserConfig({ capabilities: config });
    return resolveCapabilitiesConfig(saved.capabilities);
}

export function readLogs(lines = 100): { path: string; text: string } {
    return readRecentLogLines(lines);
}

export async function discoverCloudflareForSetup(
    forceLogin = false,
    options: { signal?: AbortSignal; onLoginOutput?: (text: string) => void } = {},
) {
    return await discoverCloudflareSetup({ forceLogin, ...options });
}

export async function configureExternalPublicAccess(
    domain: string,
    options: { signal?: AbortSignal; onPhase?: (phase: string) => void } = {},
) {
    return await configurePreparedPublicAccess(
        ({ host, port }) => Promise.resolve(prepareExternalTunnelSetup(domain, { host, port })),
        options,
    );
}

export async function configureCloudflarePublicAccess(
    input: { zone: string; prefix: string; allowDnsOverwrite: boolean },
    options: { signal?: AbortSignal; onPhase?: (phase: string) => void } = {},
) {
    return await configurePreparedPublicAccess(
        ({ host, port }) => prepareCloudflareTunnelSetup({
            host,
            port,
            zone: input.zone,
            prefix: input.prefix,
        }),
        {
            ...options,
            confirmDnsOverwrite: async (domain) => {
                if (!input.allowDnsOverwrite) {
                    throw new Error(`域名 ${domain} 已有其它 DNS 记录；请在控制台确认允许替换后重试`);
                }
            },
        },
    );
}

export async function verifyPublicAccess() {
    return await checkPublicAccess();
}

export async function selfUpdate(options: { signal?: AbortSignal; onOutput?: (text: string) => void } = {}): Promise<void> {
    await runSelfUpdate(options);
}

export function preferredRuntimeIntent(config = loadUserConfig()): RuntimeIntent {
    if (config.runtime) {
        return canonicalRuntimeIntent({
            local: config.runtime.mode === "local",
            noTunnel: config.runtime.noTunnel === true,
            tunnelLogs: config.runtime.tunnelLogs === true,
        });
    }
    return config.publicAccess
        ? { local: false, noTunnel: false, tunnelLogs: false }
        : { local: true, noTunnel: true, tunnelLogs: false };
}

function persistRuntimeIntent(intent: RuntimeIntent): void {
    const normalized = canonicalRuntimeIntent(intent);
    saveUserConfig({
        runtime: {
            mode: normalized.local ? "local" : "public",
            noTunnel: normalized.noTunnel,
            tunnelLogs: normalized.tunnelLogs,
        },
    });
}

function canonicalRuntimeIntent(intent: RuntimeIntent): RuntimeIntent {
    return intent.local
        ? { local: true, noTunnel: true, tunnelLogs: false }
        : { local: false, noTunnel: intent.noTunnel, tunnelLogs: intent.tunnelLogs };
}

async function ensureRuntime(intent: RuntimeIntent, intentSpecified: boolean) {
    const existing = await contactRunningDaemon();
    if (existing && !intentSpecified) return existing;
    if (existing && sameIntent(existing.state.runtimeIntent, intent)) return existing;
    return await withDaemonLifecycleLock(async () => {
        const current = await contactRunningDaemon();
        if (current && !intentSpecified) return current;
        if (current && sameIntent(current.state.runtimeIntent, intent)) return current;
        await assertIntentReady(intent);
        if (current) await stopDaemonContact(current);
        return await startDaemonForIntent(intent);
    });
}

async function assertIntentReady(intent: Pick<RuntimeIntent, "local" | "noTunnel">): Promise<void> {
    if (intent.local) return;
    const config = loadUserConfig();
    if (!config.publicAccess) throw new Error("还没有配置公网连接；请打开 Web Console 的“连接”页面，或运行 `aimcp setup`");
    if (!(await hasAdminPassword())) throw new Error("还没有设置连接密码；请在 Web Console 的“连接”页面设置，或运行 `aimcp auth`");
    if (!intent.noTunnel && config.publicAccess.kind === "cloudflare") {
        await loadCommittedTunnelSetup(config, config.host ?? "127.0.0.1", config.port ?? 3920);
    }
}

function sameIntent(left: RuntimeIntent, right: RuntimeIntent): boolean {
    return left.local === right.local && left.noTunnel === right.noTunnel && left.tunnelLogs === right.tunnelLogs;
}

function resolveProjectSelection<T extends RegisteredProject>(projects: T[], target: string): T | undefined {
    const byId = projects.find((item) => item.id === target);
    if (byId) return byId;
    const byName = projects.filter((item) => item.name === target);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`项目名 ${target} 不唯一，请使用项目 ID 或完整目录`);
    try {
        const path = canonicalProjectPath(target);
        return projects.find((item) => item.path === path);
    } catch {
        return undefined;
    }
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// Keep the import live for consumers that need to construct registries in tests.
void ProjectRegistry;
