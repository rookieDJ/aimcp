import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { describeOAuthDiagnostics } from "../auth/diagnostics.js";
import { geminiCapabilityProvider } from "../capabilities/providers/gemini.js";
import { hasAdminPassword } from "../auth/password-store.js";
import { findRipgrep } from "../lib/search/ripgrep.js";
import { runSubprocess } from "../lib/util/subprocess.js";
import { suggestCloudflaredBin, probeCloudflaredVersion } from "../tunnel/bin.js";
import {
    getCloudflareOriginCertPath,
    hasManagedCloudflareLogin,
    readManagedCloudflareOriginToken,
    readTunnelCredentialIdentity,
} from "../tunnel/cloudflare-account.js";
import { getCredentialsPath, resolveCloudflaredRuntimeConfigPath } from "../tunnel/yml.js";
import { getUserConfigPath, loadUserConfig } from "../config/user-config.js";
import { describeEnabledCapabilitySources, resolveCapabilitiesConfig } from "../capabilities/config.js";
import { dnsSnapshotPointsToTunnel, inspectCloudflareTunnel, snapshotCloudflareDns } from "../tunnel/cloudflare-api.js";
import { contactRunningDaemon } from "../daemon/control.js";
import { loadCommittedTunnelSetup } from "../tunnel/setup.js";
import { loadProjectsFile, loadBindingsFile } from "../daemon/state.js";
import { PACKAGE_VERSION } from "../server/version.js";
import { safeHttpGet } from "../lib/http/safe-http.js";
import { verifyRunningPublicRoute } from "../tunnel/setup-verify.js";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorCheck {
    label: string;
    level: DoctorLevel;
    detail: string;
    hint?: string;
}

export interface DoctorOptions { signal?: AbortSignal; onPhase?: (phase: string) => void }

export interface DoctorReport {
    checkedAt: string;
    checks: DoctorCheck[];
    errors: number;
    warnings: number;
}

export async function runDoctorChecks(options: DoctorOptions = {}): Promise<DoctorReport> {
    const phase = (message: string) => { options.signal?.throwIfAborted(); options.onPhase?.(message); };
    phase("检查运行环境与本机设置");
    const checks: DoctorCheck[] = [];

    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    checks.push({
        label: "Node.js",
        level: nodeMajor >= 22 ? "ok" : "error",
        detail:
            nodeMajor >= 22
                ? `版本 ${process.versions.node}`
                : `当前是 ${process.versions.node}，需要 22 或更高版本`,
    });

    checks.push(await checkCommand("Git", "git", ["--version"], false));
    checks.push(await checkRipgrep());

    let userConfig: ReturnType<typeof loadUserConfig> | undefined;
    try {
        userConfig = loadUserConfig();
        checks.push({
            label: "配置文件",
            level: existsSync(getUserConfigPath()) ? "ok" : "warn",
            detail: existsSync(getUserConfigPath())
                ? getUserConfigPath()
                : "还没有配置，运行 `aimcp setup` 即可",
        });
    } catch (error) {
        checks.push({
            label: "配置文件",
            level: "error",
            detail: readableError(error),
        });
    }

    const capabilityConfig = resolveCapabilitiesConfig(userConfig?.capabilities);
    checks.push({
        label: "外部能力",
        level: "ok",
        detail: `${describeEnabledCapabilitySources(capabilityConfig)} · ${capabilityConfig.sync === "watch" ? "自动同步" : "仅启动读取"}`,
    });
    if (capabilityConfig.sources.codex.mcp) {
        checks.push(await checkCommand("ChatGPT（Codex CLI）", "codex", ["--version"], false));
    }

    if (capabilityConfig.sources.gemini.mcp) {
        const loaded = await geminiCapabilityProvider.loadMcp!({ homeDirectory: homedir(), primaryWorkspace: process.cwd(), workspaceRoots: [], includeUserScope: true, includeProjectScope: false });
        checks.push({ label: "Gemini 外部能力", level: loaded.warnings?.length ? "warn" : "ok", detail: loaded.warnings?.join("；") ?? `已读取用户配置：${Object.keys(loaded.config.mcpServers).length} 个可导入 MCP 服务`, hint: "项目配置仅在选择对应项目后读取；在系统页面可开启或停用 Gemini 来源。" });
    }

    const publicAccess = userConfig?.publicAccess;
    const publicModeExpected = userConfig?.runtime?.mode === "public" || (!userConfig?.runtime && publicAccess !== undefined);
    try {
        const configured = await hasAdminPassword();
        checks.push({
            label: "连接密码",
            level: configured ? "ok" : publicModeExpected ? "error" : "warn",
            detail: configured
                ? "已设置"
                : publicModeExpected
                  ? "未设置；公网连接需要连接密码，请在 Web Console 的“连接”页面设置，或运行 `aimcp auth`"
                  : "未设置；仅本机模式不需要，远程 MCP 客户端连接时再设置即可",
        });
    } catch (error) {
        checks.push({
            label: "连接密码",
            level: "error",
            detail: readableError(error),
        });
    }

    if (publicAccess) {
        checks.push({
            label: "公网地址",
            level: "ok",
            detail: `https://${publicAccess.domain}/mcp`,
        });
    } else {
        checks.push({
            label: "公网地址",
            level: userConfig?.runtime?.mode === "public" ? "error" : "warn",
            detail: userConfig?.runtime?.mode === "public"
                ? "未设置；当前默认启动是公网模式，请在 Web Console 的“连接”页面配置，或运行 `aimcp setup`"
                : "未设置；当前仍可仅本机使用，需要远程 MCP 客户端连接时再配置即可",
        });
    }

    phase("检查项目登记与会话绑定");
    let projects: ReturnType<typeof loadProjectsFile> | undefined;
    try {
        projects = loadProjectsFile();
        const active = projects.filter(project => project.active);
        checks.push({ label: "项目登记", level: active.length ? "ok" : "warn", detail: `${projects.length} 个已登记项目，${active.length} 个可用项目`, ...(!active.length ? { hint: "请添加项目或启用已有项目，再让客户端选择项目。" } : {}) });
        const unreadable = active.filter(project => {
            try { accessSync(project.path, constants.R_OK); return !statSync(project.path).isDirectory(); } catch { return true; }
        });
        checks.push({ label: "项目目录", level: unreadable.length ? "error" : "ok", detail: unreadable.length ? `${unreadable.length} 个可用项目的目录不存在或不可读` : "已启用的项目目录可以读取", ...(unreadable.length ? { hint: "检查项目是否移动或外接磁盘是否在线；在项目页面取消旧登记并添加正确目录。" } : {}) });
    } catch (error) { checks.push({ label: "项目登记", level: "error", detail: readableError(error), hint: "项目登记状态无法读取；保留原文件，修复 JSON 或恢复备份，不要清空项目目录。" }); }
    try {
        const bindings = loadBindingsFile();
        const invalid = projects ? bindings.filter(binding => !projects!.some(project => project.id === binding.projectId && project.active)) : [];
        checks.push({ label: "会话绑定", level: invalid.length ? "warn" : "ok", detail: `${bindings.length} 个项目会话绑定${invalid.length ? `，${invalid.length} 个指向停用或已移除项目` : ""}`, ...(invalid.length ? { hint: "在项目页面清理失效绑定，再让客户端重新选择可用项目。" } : {}) });
    } catch (error) { checks.push({ label: "会话绑定", level: "error", detail: readableError(error), hint: "会话绑定状态无法读取；保留原文件，修复或恢复备份后重新选择项目。" }); }

    phase("检查公网配置与 Cloudflare 资源");
    if (publicAccess?.kind === "external") {
        checks.push({
            label: "Cloudflare Tunnel",
            level: "warn",
            detail: "已关闭。请确认你自己准备了可用的 HTTPS 公网入口",
        });
    } else if (publicAccess?.kind === "cloudflare") {
        const cloudflaredBin = await suggestCloudflaredBin(publicAccess.cloudflaredBin);
        if (!cloudflaredBin) {
            checks.push({
                label: "cloudflared",
                level: "error",
                detail: "没有找到 cloudflared；运行 `aimcp doctor --fix` 恢复本机组件，无需重新创建 Tunnel",
            });
        } else {
            try {
                const version = await probeCloudflaredVersion(cloudflaredBin);
                checks.push({ label: "cloudflared", level: "ok", detail: version });
            } catch (error) {
                checks.push({
                    label: "cloudflared",
                    level: "error",
                    detail: readableError(error),
                });
            }
        }

        const managedLoginPath = getCloudflareOriginCertPath();
        const managedLogin = hasManagedCloudflareLogin();
        checks.push({
            label: "Cloudflare 登录",
            level: managedLogin ? "ok" : "warn",
            detail: managedLogin
                ? `aimcp 私有登录：${managedLoginPath}`
                : "没有可用的 aimcp 私有登录；Tunnel 仍可运行，但修改或远端诊断时需要重新登录",
        });

        const credentialsPath = getCredentialsPath(publicAccess.tunnelId);
        const managedCredentials = canRead(credentialsPath);
        if (managedCredentials) {
            try {
                const identity = readTunnelCredentialIdentity(credentialsPath);
                const mismatch = identity.tunnelId !== publicAccess.tunnelId ||
                    identity.accountId !== publicAccess.accountId;
                checks.push({
                    label: "Tunnel 凭据",
                    level: mismatch ? "error" : "ok",
                    detail: mismatch
                        ? "credential 的 TunnelID / AccountTag 与已提交配置不一致"
                        : `${credentialsPath} · Tunnel / 账号一致`,
                });
            } catch (error) {
                checks.push({ label: "Tunnel 凭据", level: "error", detail: readableError(error) });
            }
        } else {
            checks.push({
                label: "Tunnel 凭据",
                level: "error",
                detail: `缺少本机凭据：${credentialsPath}`,
            });
        }

        const runtimeConfigPath = resolveCloudflaredRuntimeConfigPath(publicAccess);
        try {
            await loadCommittedTunnelSetup(userConfig);
            checks.push({ label: "Tunnel 配置一致性", level: "ok", detail: runtimeConfigPath });
        } catch (error) {
            checks.push({ label: "Tunnel 配置一致性", level: "error", detail: readableError(error) });
        }

        if (managedLogin) {
            try {
                const login = readManagedCloudflareOriginToken();
                if (login.accountID !== publicAccess.accountId) {
                    checks.push({
                        label: "Cloudflare 账号一致性",
                        level: "error",
                        detail: "当前私有登录账号与已提交 Tunnel 账号不同；运行 setup 重新选择账号",
                    });
                } else {
                    checks.push({ label: "Cloudflare 账号一致性", level: "ok", detail: publicAccess.accountId });
                }
            } catch (error) {
                checks.push({ label: "Cloudflare 账号一致性", level: "error", detail: readableError(error) });
            }
            try {
                const [tunnel, dns] = await Promise.all([
                    inspectCloudflareTunnel(publicAccess.accountId, publicAccess.tunnelId, { signal: options.signal, timeoutMs: 10_000 }),
                    snapshotCloudflareDns(publicAccess.zoneId, publicAccess.domain, { signal: options.signal, timeoutMs: 10_000 }),
                ]);
                checks.push({
                    label: "Cloudflare Tunnel 远端状态",
                    level: tunnel.exists ? (tunnel.status === "healthy" ? "ok" : "warn") : "error",
                    detail: tunnel.exists
                        ? `${tunnel.status ?? "状态未知"} · ${tunnel.connectorCount ?? 0} 个 connector`
                        : "远端 Tunnel 不存在或已删除",
                    hint: tunnel.exists ? "down / inactive 表示当前没有可用 connector；先检查运行模式和网络，通常无需重新配置。" : "核对 Cloudflare 资源后重新配置；自动修复不会创建或覆盖远端资源。",
                });
                const dnsMatches = dnsSnapshotPointsToTunnel(dns, publicAccess.tunnelId);
                checks.push({
                    label: "Cloudflare DNS 一致性",
                    level: dnsMatches ? "ok" : "error",
                    detail: dnsMatches
                        ? `${publicAccess.domain} → ${publicAccess.tunnelId}.cfargotunnel.com`
                        : `${publicAccess.domain} 没有唯一指向已提交 Tunnel`,
                });
            } catch (error) {
                checks.push({
                    label: "Cloudflare 远端诊断",
                    level: "warn",
                    detail: `只读 API 检查失败：${readableError(error)}`,
                });
            }
        } else {
            checks.push({
                label: "Cloudflare 远端诊断",
                level: "warn",
                detail: "没有可用的 aimcp 私有登录；运行 setup 重新登录后可启用远端一致性检查",
            });
        }
    }

    phase("检查当前 MCP 服务和真实工具调用");
    try {
        const daemon = await contactRunningDaemon();
        if (daemon) {
            const status = await daemon.client.status();
            checks.push({ label: "守护进程", level: "ok", detail: `pid ${status.pid} · ${status.mode === "local" ? "本机" : "公网"} · ${status.version}` });
            checks.push({ label: "运行版本", level: status.version === PACKAGE_VERSION ? "ok" : "warn", detail: `当前服务 ${status.version}，本次检查 ${PACKAGE_VERSION}`, ...(status.version !== PACKAGE_VERSION ? { hint: "升级后运行 aimcp restart，才能让新版本的恢复机制生效。" } : {}) });
            try {
                const result = await daemon.client.checkTools();
                checks.push({ label: "MCP 工具与项目读取", level: result.projectCount ? "ok" : "warn", detail: `${result.toolCount} 个工具，${result.projectCount} 个可用项目；真实 MCP 请求已响应`, ...(!result.projectCount ? { hint: "在项目页面添加或启用项目。" } : {}) });
            } catch {
                checks.push({ label: "MCP 工具与项目读取", level: "error", detail: "本机控制接口可用，但 MCP 工具调用失败", hint: "查看运行日志；必要时运行 aimcp restart，重启后重新选择项目。" });
            }
            if (publicAccess && status.mode === "public") {
                try {
                    const observations = await daemon.client.oauthDiagnostics();
                    const rejected = observations.events.slice(-8).some(event => event.outcome === "rejected" || event.outcome === "aborted");
                    checks.push({ label: "客户端授权阶段", level: rejected ? "warn" : "ok", detail: describeOAuthDiagnostics(observations), hint: "仅列出本次启动后最近收到的请求，不代表某个聊天已连接。MCP 的 401 是授权挑战，也可能表示令牌失效，需对照后续请求。若 Google 页面报 500，重试后对照注册、授权页面、令牌交换阶段；没有请求到达时检查 Gemini 账号、浏览器与网络。浏览器标识仅供排查，不作为身份依据。" });
                } catch {
                    checks.push({ label: "客户端授权阶段", level: "warn", detail: "当前 Runtime 不支持授权阶段诊断。", hint: "使用最新版 aimcp 重启 Runtime 后再试。" });
                }
                const expected = `https://${publicAccess.domain}/mcp`;
                checks.push({ label: "Daemon 配置一致性", level: status.publicMcpUrl === expected ? "ok" : "error", detail: status.publicMcpUrl === expected ? expected : "正在运行的公网地址与已保存配置不同", ...(status.publicMcpUrl !== expected ? { hint: "运行 aimcp restart 载入已保存配置。" } : {}) });
                if (publicAccess.kind === "cloudflare" && !status.runtimeIntent.noTunnel) {
                    const state = status.tunnel.state;
                    checks.push({ label: "Tunnel 运行状态", level: state === "connected" ? "ok" : state === "starting" || state === "degraded" ? "warn" : "error", detail: `${tunnelStateLabel(state)} · 自动恢复 ${status.tunnel.restartCount ?? 0} 次${status.tunnel.detail ? ` · ${status.tunnel.detail}` : ""}`, ...(state !== "connected" ? { hint: "先等待自动重连；也可运行 aimcp doctor --fix 仅重连本机隧道。网络中断无需重新 setup。" } : {}) });
                } else if (publicAccess.kind === "cloudflare") {
                    checks.push({ label: "Tunnel 运行状态", level: "warn", detail: "当前使用 --no-tunnel，托管隧道未启动", hint: "需要托管公网入口时运行 aimcp start --public，取消 --no-tunnel。" });
                }
                phase("验证公网实例和 OAuth 登录入口");
                try {
                    await verifyRunningPublicRoute(publicAccess.domain, daemon.state.host, daemon.state.port, { totalTimeoutMs: 10_000, signal: options.signal });
                    checks.push({ label: "公网实例一致性", level: "ok", detail: "公网与本机返回相同 instance" });
                    try {
                        await checkPublicAuth(publicAccess.domain, options.signal);
                        checks.push({ label: "OAuth 入口", level: "ok", detail: "MCP 登录保护、授权发现、PKCE 配置均正常" });
                    } catch {
                        checks.push({ label: "OAuth 入口", level: "error", detail: "公网实例可达，但 MCP 登录保护或授权发现不正确", hint: "检查反向代理是否拦截 /.well-known 和 /mcp；不要关闭 OAuth 或密码保护。" });
                    }
                } catch {
                    options.signal?.throwIfAborted();
                    checks.push({ label: "公网实例一致性", level: "error", detail: "公网入口未能验证为当前本机实例", hint: publicAccess.kind === "cloudflare" ? "若隧道中断，等待自动重连或运行 doctor --fix；若隧道正常，检查 DNS、代理和网络。" : "检查自己的 HTTPS 代理是否指向当前 MCP 端口。" });
                }
            } else if (publicAccess) {
                checks.push({ label: "Daemon 配置一致性", level: "ok", detail: "当前仅本机运行，已保存公网配置未启用；本机客户端可正常连接" });
            }
        } else {
            checks.push({ label: "守护进程", level: "warn", detail: "未运行；项目注册和公网配置仍保留", hint: "运行 aimcp start；doctor --fix 不会自动启动已停止的服务。" });
        }
    } catch (error) {
        options.signal?.throwIfAborted();
        checks.push({ label: "守护进程", level: "error", detail: readableError(error), hint: "检查本机状态文件和运行日志；不要直接结束身份不明的进程。" });
    }
    phase("汇总诊断结果");

    const errors = checks.filter((item) => item.level === "error").length;
    const warnings = checks.filter((item) => item.level === "warn").length;
    return { checkedAt: new Date().toISOString(), checks, errors, warnings };
}

async function checkRipgrep(): Promise<DoctorCheck> {
    const binary = await findRipgrep();
    if (!binary) {
        return {
            label: "文件搜索",
            level: "error",
            detail: "文件搜索组件缺失；运行 `aimcp doctor --fix` 可以自动恢复",
        };
    }
    try {
        const result = await runSubprocess(binary, ["--version"], {
            timeoutMs: 5_000,
            maxStdoutBytes: 16 * 1024,
            maxStderrBytes: 16 * 1024,
            maxTotalBytes: 32 * 1024,
        });
        const firstLine = `${result.stdout}\n${result.stderr}`
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        return {
            label: "文件搜索",
            level: result.exitCode === 0 ? "ok" : "error",
            detail:
                result.exitCode === 0
                    ? firstLine ?? "已安装"
                    : "文件搜索组件存在，但无法正常启动",
        };
    } catch {
        return {
            label: "文件搜索",
            level: "error",
            detail: "文件搜索组件存在，但无法正常启动",
        };
    }
}

async function checkCommand(
    label: string,
    command: string,
    args: string[],
    required: boolean,
): Promise<DoctorCheck> {
    try {
        const result = await runSubprocess(command, args, {
            timeoutMs: 5_000,
            maxStdoutBytes: 16 * 1024,
            maxStderrBytes: 16 * 1024,
            maxTotalBytes: 32 * 1024,
        });
        if (result.exitCode !== 0) {
            return {
                label,
                level: required ? "error" : "warn",
                detail: `${command} 可以启动，但返回了错误`,
            };
        }
        const firstLine = `${result.stdout}\n${result.stderr}`
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        return {
            label,
            level: "ok",
            detail: firstLine ?? "已安装",
        };
    } catch {
        return {
            label,
            level: required ? "error" : "warn",
            detail:
                label === "ChatGPT（Codex CLI）"
                    ? "没有找到 Codex CLI；ChatGPT 仍可使用核心 MCP 功能，但无法导入该本机客户端的 MCP"
                    : label === "Git"
                      ? "没有找到；Git 状态、历史和差异相关功能不可用"
                      : "没有找到",
        };
    }
}

function canRead(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function tunnelStateLabel(state: string): string {
    return ({ off: "未启动", starting: "连接中", connected: "已连接", degraded: "中断，正在恢复", exited: "已退出" } as Record<string, string>)[state] ?? state;
}

async function checkPublicAuth(domain: string, signal?: AbortSignal): Promise<void> {
    const origin = `https://${domain}`;
    const request = (path: string) => safeHttpGet(`${origin}${path}`, { httpsOnly: true, maxBytes: 16_384, maxRedirects: 0, timeoutMs: 5_000, signal, headers: { Accept: "application/json, text/event-stream" } });
    const [challenge, resource, server] = await Promise.all([request("/mcp"), request("/.well-known/oauth-protected-resource/mcp"), request("/.well-known/oauth-authorization-server")]);
    if (challenge.status !== 401 || !challenge.headers["www-authenticate"]?.includes("Bearer") || resource.status !== 200 || server.status !== 200) throw new Error("OAuth 发现失败");
    validateDoctorOAuthMetadata(domain, JSON.parse(resource.body.toString("utf8")), JSON.parse(server.body.toString("utf8")));
}

/** Validate metadata without following any server-supplied endpoint. */
export function validateDoctorOAuthMetadata(domain: string, protectedResource: Record<string, unknown>, authorization: Record<string, unknown>): void {
    const origin = `https://${domain}`;
    const issuer = `${origin}/`;
    if (protectedResource.resource !== `${origin}/mcp` || !Array.isArray(protectedResource.authorization_servers) || !protectedResource.authorization_servers.includes(issuer) || authorization.issuer !== issuer || !Array.isArray(authorization.code_challenge_methods_supported) || !authorization.code_challenge_methods_supported.includes("S256")) throw new Error("OAuth 发现地址不一致");
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
        if (typeof authorization[key] !== "string") throw new Error("OAuth 端点缺失");
        const endpoint = new URL(authorization[key]);
        if (endpoint.origin !== origin || endpoint.username || endpoint.password || endpoint.hash) throw new Error("OAuth 端点不一致");
    }
}
