import { get as httpGet } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { terminateChildProcess } from "../lib/process/tree.js";
import { printCompactLog } from "../lib/util/terminal.js";
import { ensureUserConfigDirs, getUserLogDir } from "../config/user-config.js";
import { cloudflaredChildEnv } from "./exec.js";
import { openPrivateAppendFile } from "../lib/fs/atomic-file.js";

const DEFAULT_READY_TIMEOUT_MS = 180_000;
const MAX_DIAGNOSTIC_LOG_CHARS = 16_000;

export function cloudflaredRunArgs(configPath: string, tunnelId: string): string[] {
    return [
        "tunnel",
        "--config",
        configPath,
        "--metrics",
        "127.0.0.1:0",
        "--edge-ip-version",
        "4",
        "run",
        tunnelId,
    ];
}

export function tunnelReadinessTimeoutMessage(
    timeoutMs: number,
    logText: string,
    logPath: string,
): string {
    const prefix = `公网连接在 ${Math.round(timeoutMs / 1000)} 秒内没有准备好。`;
    const ipv6Tcp7844Timeout = /\[[0-9a-f:]+\]:7844[^\n]*(?:i\/o timeout|timed out|timeout)/i.test(
        logText,
    );
    if (ipv6Tcp7844Timeout) {
        return `${prefix} Cloudflare 的 IPv6 连接超时。当前版本已经强制使用 IPv4；请确认网络允许访问 TCP 7844。日志：${logPath}`;
    }

    const tcp7844Failure =
        /TCP Connectivity[^\n]*FAIL[^\n]*HTTP\/2[^\n]*(?:blocked|unreachable)/i.test(logText) ||
        /(?:dial tcp|TLS handshake)[^\n]*:7844[^\n]*(?:i\/o timeout|timed out|timeout|refused|unreachable)/i.test(
            logText,
        );
    if (tcp7844Failure) {
        return `${prefix} Cloudflare 已回退到 HTTP/2，但 TCP 7844 仍不可达。请检查防火墙或网络限制；自动模式也会优先尝试 QUIC/UDP 7844。日志：${logPath}`;
    }

    return `${prefix} 请检查网络是否允许访问 Cloudflare UDP 或 TCP 7844。日志：${logPath}`;
}

export interface TunnelSidecarOptions {
    bin: string;
    tunnelId: string;
    configPath: string;
    /** Mirror log lines to the parent terminal with a prefix. */
    mirrorLogs?: boolean;
    /** Max wait for edge registration (ms). */
    readyTimeoutMs?: number;
    /** Daemon mode only: restart a connector that exits after becoming ready. */
    maxRestarts?: number;
    /** Keep recovering in cooldown cycles for a long-lived daemon; setup probes stay bounded. */
    autoRecover?: boolean;
    healthIntervalMs?: number;
    disconnectGraceMs?: number;
    restartDelayMs?: number;
    restartMaxDelayMs?: number;
    recoveryCooldownMs?: number;
    stableResetMs?: number;
    onStateChange?: (status: TunnelSidecarStatus) => void;
}

export interface TunnelReadyInfo {
    /** Cloudflare PoP code when present (e.g. hkg01). */
    location?: string;
    /** Transport used for the first connection (e.g. http2). */
    protocol?: string;
}

export type TunnelSidecarState = "off" | "starting" | "connected" | "degraded" | "exited";

export interface TunnelSidecarStatus {
    running: boolean;
    state: TunnelSidecarState;
    restartCount: number;
    detail?: string;
}

/**
 * Manage a long-running `cloudflared tunnel run` child process.
 *
 * Logs go to the existing `~/.ai-mcp/logs/tunnel.log` path by default so the project
 * terminal stays readable. `start()` only resolves after Cloudflare
 * accepts a connector (`Registered tunnel connection`).
 */
export class CloudflaredSidecar {
    private child: ChildProcess | undefined;
    private logStream: WriteStream | undefined;
    private readonly logPath: string;
    private readonly readyTimeoutMs: number;
    private readyResolve: ((info: TunnelReadyInfo) => void) | undefined;
    private readyReject: ((error: Error) => void) | undefined;
    private activeStart: Promise<TunnelReadyInfo> | undefined;
    private manualRecovery: Promise<TunnelReadyInfo> | undefined;
    private stopping = false;
    private lifecycleVersion = 0;
    private recycling = false;
    private recyclingTask: Promise<void> | undefined;
    private everReady = false;
    private registered = new Set<string>();
    private diagnosticTail = "";
    private logLineCarry = "";
    private restartCount = 0;
    private consecutiveRestarts = 0;
    private state: TunnelSidecarState = "off";
    private restartTimer: ReturnType<typeof setTimeout> | undefined;
    private healthTimer: ReturnType<typeof setTimeout> | undefined;
    private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private stableTimer: ReturnType<typeof setTimeout> | undefined;
    private healthAbort: AbortController | undefined;
    private metricsPort: number | undefined;
    private healthFailures = 0;

    constructor(private readonly options: TunnelSidecarOptions) {
        ensureUserConfigDirs();
        mkdirSync(getUserLogDir(), { recursive: true });
        this.logPath = join(getUserLogDir(), "tunnel.log");
        this.readyTimeoutMs = positive(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    }

    getLogPath(): string { return this.logPath; }

    async start(): Promise<TunnelReadyInfo> {
        if (this.child || this.activeStart || this.restartTimer) throw new Error("Cloudflare Tunnel 已经在运行或恢复中");
        this.stopping = false;
        this.restartCount = 0;
        this.consecutiveRestarts = 0;
        return await this.launch();
    }

    /** Recover only this owned connector, keeping the MCP server and project sessions alive. */
    async restart(): Promise<TunnelReadyInfo> {
        if (this.manualRecovery) return await this.manualRecovery;
        const task = (async () => {
            const stopped = this.stop();
            const version = this.lifecycleVersion;
            await stopped;
            if (version !== this.lifecycleVersion) throw new Error("隧道恢复已取消");
            try { return await this.start(); }
            catch (error) {
                if (this.options.autoRecover && !this.stopping) this.scheduleRestart("手动重连暂未成功，继续自动恢复");
                throw error;
            }
        })();
        this.manualRecovery = task;
        try { return await task; }
        finally { if (this.manualRecovery === task) this.manualRecovery = undefined; }
    }

    private launch(): Promise<TunnelReadyInfo> {
        const task = this.startOnce();
        this.activeStart = task;
        void task.finally(() => { if (this.activeStart === task) this.activeStart = undefined; }).catch(() => undefined);
        return task;
    }

    private async startOnce(): Promise<TunnelReadyInfo> {
        if (this.child || this.stopping) throw new Error("Cloudflare Tunnel 已运行或已停止");
        this.emitState("starting", false);
        this.clearHealth();
        this.everReady = false;
        this.registered.clear();
        this.logLineCarry = "";
        this.diagnosticTail = "";
        this.metricsPort = undefined;
        this.healthFailures = 0;
        const stream = createWriteStream(this.logPath, { fd: openPrivateAppendFile(this.logPath), autoClose: true });
        this.logStream = stream;
        stream.on("error", () => { if (this.logStream === stream) this.logStream = undefined; });
        this.writeLog(`\n---- ${new Date().toISOString()} start tunnel ${this.options.tunnelId} ----\n`);
        const readyPromise = new Promise<TunnelReadyInfo>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        const child = spawn(this.options.bin, cloudflaredRunArgs(this.options.configPath, this.options.tunnelId), {
            stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: cloudflaredChildEnv(),
        });
        this.child = child;
        child.stdout?.on("data", (chunk: Buffer) => { if (this.child === child) this.onLogChunk(chunk.toString("utf8")); });
        child.stderr?.on("data", (chunk: Buffer) => { if (this.child === child) this.onLogChunk(chunk.toString("utf8")); });
        child.on("error", () => { if (this.child === child) this.failReady(new Error(`无法启动 cloudflared，请运行 aimcp doctor。日志：${this.logPath}`)); });
        child.on("close", (code) => {
            if (this.child !== child) { stream.end(); return; }
            this.writeLog(`---- exited code=${code ?? "null"} ----\n`);
            stream.end();
            this.child = undefined;
            if (this.logStream === stream) this.logStream = undefined;
            this.clearHealth();
            if (!this.everReady) this.failReady(new Error(`cloudflared 在公网连接准备好之前退出了（代码 ${code}）。日志：${this.logPath}`));
            else if (!this.stopping && !this.recycling) this.scheduleRestart(`cloudflared 退出（代码 ${code ?? "null"}）`);
        });
        const timer = setTimeout(() => this.failReady(new Error(tunnelReadinessTimeoutMessage(this.readyTimeoutMs, this.diagnosticTail, this.logPath))), this.readyTimeoutMs);
        try {
            return await readyPromise;
        } catch (error) {
            await this.terminateCurrent();
            if (!this.stopping) this.emitState("exited", false, error instanceof Error ? error.message : "连接准备失败");
            throw error;
        } finally {
            clearTimeout(timer);
            this.readyResolve = undefined;
            this.readyReject = undefined;
        }
    }

    async stop(): Promise<void> {
        this.lifecycleVersion++;
        this.stopping = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        this.clearHealth();
        this.failReady(new Error("Cloudflare 连接准备已取消"));
        await this.terminateCurrent();
        await this.activeStart?.catch(() => undefined);
        await this.recyclingTask;
        this.emitState("off", false);
    }

    private onLogChunk(text: string): void {
        this.writeLog(text);
        this.diagnosticTail = (this.diagnosticTail + text).slice(-MAX_DIAGNOSTIC_LOG_CHARS);
        const lines = (this.logLineCarry + text).split(/\r?\n/);
        this.logLineCarry = (lines.pop() ?? "").slice(-MAX_DIAGNOSTIC_LOG_CHARS);
        for (const line of lines) {
            if (this.stopping || this.recycling) return;
            const port = /Starting metrics server on 127\.0\.0\.1:(\d+)\/metrics(?:\s|$)/.exec(line)?.[1];
            if (port && Number(port) > 0 && Number(port) <= 65535 && this.metricsPort === undefined) {
                this.metricsPort = Number(port);
                this.scheduleHealth();
            }
            const index = /(?:^|\s)connIndex=(\d+)(?:\s|$)/.exec(line)?.[1] ?? "0";
            if (line.includes("Registered tunnel connection")) {
                this.registered.add(index);
                this.markConnected({ location: /(?:^|\s)location=(\S+)/.exec(line)?.[1], protocol: /(?:^|\s)protocol=(\S+)/.exec(line)?.[1] });
            } else if (/Connection terminated|Unregistered tunnel connection/.test(line)) {
                this.registered.delete(index);
                if (this.everReady && !this.registered.size) this.markDisconnected();
            }
        }
    }

    private markConnected(info: TunnelReadyInfo = {}): void {
        if (this.stopping || this.recycling) return;
        this.everReady = true;
        this.healthFailures = 0;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = undefined;
        if (this.state !== "connected") this.emitState("connected", true);
        if (!this.stableTimer) {
            this.stableTimer = setTimeout(() => { this.consecutiveRestarts = 0; this.stableTimer = undefined; }, positive(this.options.stableResetMs, 300_000));
            this.stableTimer.unref();
        }
        this.readyResolve?.(info);
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }

    private markDisconnected(): void {
        if (this.stopping || this.recycling) return;
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = undefined;
        if (this.state !== "degraded") this.emitState("degraded", Boolean(this.child), "与 Cloudflare 的连接中断，正在等待自动重连；已有配置保留");
        if (this.disconnectTimer || !this.options.autoRecover) return;
        this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = undefined;
            if (this.stopping || this.state !== "degraded") return;
            this.recycling = true;
            const task = this.terminateCurrent().then(() => {
                this.recycling = false;
                this.scheduleRestart("连接长时间未恢复，重启本机 connector");
            }, () => {
                this.recycling = false;
                if (!this.stopping) this.emitState("exited", Boolean(this.child), "connector 停止失败，请运行 aimcp doctor");
            });
            this.recyclingTask = task;
            void task.finally(() => { if (this.recyclingTask === task) this.recyclingTask = undefined; });
        }, positive(this.options.disconnectGraceMs, 180_000));
        this.disconnectTimer.unref();
    }

    private scheduleHealth(): void {
        if (this.stopping || this.metricsPort === undefined || this.healthTimer) return;
        this.healthTimer = setTimeout(() => {
            this.healthTimer = undefined;
            const child = this.child;
            const controller = new AbortController();
            this.healthAbort = controller;
            void readConnectorReady(this.metricsPort!, controller.signal).then(ready => {
                if (this.child !== child || this.stopping || this.recycling) return;
                if (ready) this.markConnected();
                else if (this.everReady) this.markDisconnected();
            }, () => {
                if (this.child !== child || this.stopping || this.recycling) return;
                if (++this.healthFailures >= 3 && this.everReady) this.markDisconnected();
            }).finally(() => {
                if (this.healthAbort === controller) this.healthAbort = undefined;
                if (this.child === child && !this.stopping) this.scheduleHealth();
            });
        }, positive(this.options.healthIntervalMs, 15_000));
        this.healthTimer.unref();
    }

    private clearHealth(): void {
        for (const timer of [this.healthTimer, this.disconnectTimer, this.stableTimer]) if (timer) clearTimeout(timer);
        this.healthTimer = this.disconnectTimer = this.stableTimer = undefined;
        this.healthAbort?.abort();
        this.healthAbort = undefined;
    }

    private failReady(error: Error): void {
        this.readyReject?.(error);
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }

    private writeLog(text: string): void {
        this.logStream?.write(text);
        if (this.options.mirrorLogs) for (const line of text.split(/\r?\n/)) if (line.trim()) printCompactLog("warning", `[tunnel] ${line}`);
    }

    private async terminateCurrent(): Promise<void> {
        const child = this.child;
        this.clearHealth();
        if (child?.pid) await terminateChildProcess(child, 2_000, 1_000);
        // Never erase a newer child from an earlier asynchronous cleanup.
        if (this.child === child) {
            this.child = undefined;
            this.logStream?.end();
            this.logStream = undefined;
        }
    }

    private scheduleRestart(detail: string): void {
        if (this.stopping || this.restartTimer) return;
        const maxRestarts = Math.max(0, this.options.maxRestarts ?? 0);
        if (this.consecutiveRestarts >= maxRestarts && !this.options.autoRecover) { this.emitState("exited", false, detail); return; }
        const cooldown = this.consecutiveRestarts >= maxRestarts;
        const delayMs = cooldown ? positive(this.options.recoveryCooldownMs, 60_000) : Math.min(positive(this.options.restartMaxDelayMs, 30_000), positive(this.options.restartDelayMs, 1_000) * 2 ** Math.min(this.consecutiveRestarts, 20));
        this.emitState("degraded", false, `${detail}；${Math.ceil(delayMs / 1000)} 秒后自动恢复，无需重新配置`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.stopping) return;
            if (cooldown) this.consecutiveRestarts = 0;
            this.consecutiveRestarts++;
            this.restartCount++;
            void this.launch().catch(() => { if (!this.stopping) this.scheduleRestart("本机 connector 重连失败"); });
        }, delayMs);
        this.restartTimer.unref();
    }

    private emitState(state: TunnelSidecarState, running: boolean, detail?: string): void {
        this.state = state;
        this.options.onStateChange?.({ running, state, restartCount: this.restartCount, ...(detail ? { detail } : {}) });
    }
}

function positive(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Fixed IPv4 loopback endpoint, no proxy, redirect, credential, or external host. */
function readConnectorReady(port: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const request = httpGet({ hostname: "127.0.0.1", port, path: "/ready", signal, timeout: 3_000 }, response => {
            let body = "";
            response.on("data", chunk => {
                body += chunk.toString();
                if (body.length > 4096) request.destroy(new Error("connector 健康响应过大"));
            });
            response.once("error", reject);
            response.once("end", () => {
                try {
                    const data = JSON.parse(body) as { readyConnections?: unknown };
                    if (response.statusCode !== 200 && response.statusCode !== 503) throw new Error("connector 健康检查无法识别");
                    if (typeof data.readyConnections !== "number" || !Number.isInteger(data.readyConnections) || data.readyConnections < 0) throw new Error("connector 健康检查无效");
                    resolve(response.statusCode === 200 && data.readyConnections > 0);
                } catch (error) { reject(error); }
            });
        });
        request.once("timeout", () => request.destroy(new Error("connector 健康检查超时")));
        request.once("error", reject);
        const deadline = setTimeout(() => request.destroy(new Error("connector 健康检查超时")), 3_000);
        request.once("close", () => clearTimeout(deadline));
    });
}
