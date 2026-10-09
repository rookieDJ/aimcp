import { contactRunningDaemon } from "../daemon/control.js";
import { loadUserConfig } from "../config/user-config.js";
import { hasAdminPassword } from "../auth/password-store.js";
import { verifyRunningPublicRoute } from "../tunnel/setup-verify.js";
import { safeHttpGet } from "../lib/http/safe-http.js";

export interface ConnectionCheck {
    checkedAt: string;
    ready: boolean;
    checks: Array<{ id: string; label: string; state: "passed" | "failed" | "pending"; detail: string; action?: "start" | "connect" | "projects" | "repair" }>;
}

export async function checkConnection(): Promise<ConnectionCheck> {
    const checks: ConnectionCheck["checks"] = [];
    const daemon = await contactRunningDaemon();
    checks.push({ id: "service", label: "本机服务", state: daemon ? "passed" : "failed", detail: daemon ? "服务正在运行。" : "请先启动服务。", ...(!daemon ? { action: "start" as const } : {}) });
    if (daemon) {
        try {
            const result = await daemon.client.checkTools();
            checks.push({ id: "tools", label: "工具与项目", state: result.projectCount ? "passed" : "failed", detail: `已成功连接工具并读取项目列表：${result.toolCount} 个工具，${result.projectCount} 个可用项目。`, ...(!result.projectCount ? { action: "projects" as const } : {}) });
        } catch {
            checks.push({ id: "tools", label: "工具与项目", state: "failed", detail: "工具检查未通过，请检查服务或重新启动。", action: "repair" });
        }
    }
    const access = loadUserConfig().publicAccess;
    const configured = Boolean(access);
    const password = await hasAdminPassword();
    checks.push({ id: "password", label: "连接密码", state: password ? "passed" : "pending", detail: password ? "已设置连接密码。" : "设置密码后才能安全接受远程 MCP 连接。", ...(!password ? { action: "connect" as const } : {}) });
    if (access && daemon) {
        let tunnelRecovering = false;
        try {
            const status = await daemon.client.status();
            tunnelRecovering = access.kind === "cloudflare" && status.mode === "public" && !status.runtimeIntent.noTunnel && status.tunnel.state !== "connected";
            if (tunnelRecovering) {
                checks.push({ id: "tunnel", label: "Cloudflare 隧道", state: "pending", detail: "本机隧道正在恢复；配置已保留，可等待重连或在系统页面诊断并修复。", action: "repair" });
            }
            if (!status.auth.required || status.publicMcpUrl !== `https://${access.domain}/mcp`) {
                checks.push({ id: "public", label: "公网地址", state: "pending", detail: "当前服务仅在本机运行，请切换到公网模式以接受远程 MCP 连接。", action: "start" });
            } else {
                await verifyRunningPublicRoute(access.domain, daemon.state.host, daemon.state.port, { totalTimeoutMs: 10_000 });
                const challenge = await safeHttpGet(status.publicMcpUrl, { httpsOnly: true, maxBytes: 4096, maxRedirects: 0, timeoutMs: 10_000, headers: { Accept: "application/json, text/event-stream" } });
                if (challenge.status !== 401 || !challenge.headers["www-authenticate"]?.includes("Bearer")) throw new Error("登录保护未正常响应");
                checks.push({ id: "public", label: "公网地址", state: "passed", detail: "公网地址指向当前服务，登录保护响应正常。" });
            }
        } catch {
            checks.push({ id: "public", label: "公网地址", state: "failed", detail: tunnelRecovering ? "隧道中断导致公网不可达，请等待自动恢复或运行诊断并修复，无需重新配置。" : "公网地址暂时不可用，请运行诊断检查隧道、DNS 与网络。", action: "repair" });
        }
    } else {
        checks.push({ id: "public", label: "公网地址", state: "pending", detail: configured ? "启动服务后再检查公网地址。" : "请先设置公网 MCP 地址。", action: configured ? "start" : "connect" });
    }
    return { checkedAt: new Date().toISOString(), ready: checks.every((item) => item.state === "passed"), checks };
}
