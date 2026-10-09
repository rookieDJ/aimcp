import type { IncomingMessage, ServerResponse } from "node:http";
import { writeRuntimeLog } from "../lib/runtime-log.js";

const MAX_EVENTS = 64;
const ENDPOINTS: Record<string, OAuthDiagnosticEvent["endpoint"]> = {
    "/mcp": "mcp",
    "/.well-known/oauth-protected-resource": "resource_metadata",
    "/.well-known/oauth-protected-resource/mcp": "resource_metadata",
    "/.well-known/oauth-authorization-server": "authorization_metadata",
    "/register": "register",
    "/authorize": "authorize",
    "/token": "token",
    "/revoke": "revoke",
};

export interface OAuthDiagnosticEvent {
    at: string;
    endpoint: "mcp" | "resource_metadata" | "authorization_metadata" | "register" | "authorize" | "token" | "revoke";
    method: "GET" | "HEAD" | "POST" | "OPTIONS" | "OTHER";
    status: number;
    outcome: "responded" | "approved" | "challenge" | "rejected" | "aborted";
    platform: "macos" | "windows" | "other" | "unknown";
    browser: "chrome" | "safari" | "edge" | "firefox" | "other" | "unknown";
}

export interface OAuthDiagnosticsSnapshot {
    startedAt: string;
    events: OAuthDiagnosticEvent[];
}

/** Bounded, process-local observations. Never retain request bodies, URLs or identifiers. */
export class OAuthDiagnostics {
    private readonly startedAt = new Date().toISOString();
    private readonly events: OAuthDiagnosticEvent[] = [];

    snapshot(): OAuthDiagnosticsSnapshot {
        return { startedAt: this.startedAt, events: this.events.map(event => ({ ...event })) };
    }

    observe = (req: IncomingMessage, res: ServerResponse): void => {
        let path: string;
        try { path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/$/, ""); }
        catch { return; }
        const endpoint = ENDPOINTS[path];
        if (!endpoint) return;
        const ua = req.headers["user-agent"] ?? "";
        const platform = /Windows/i.test(ua) ? "windows" : /Macintosh|Mac OS X/i.test(ua) ? "macos" : ua ? "other" : "unknown";
        const browser = /Edg\//i.test(ua) ? "edge" : /Firefox\//i.test(ua) ? "firefox" : /Chrome\//i.test(ua) ? "chrome" : /Version\/.*Safari\//i.test(ua) ? "safari" : ua ? "other" : "unknown";
        const method = ["GET", "HEAD", "POST", "OPTIONS"].includes(req.method ?? "") ? req.method as OAuthDiagnosticEvent["method"] : "OTHER";
        let recorded = false;
        const record = (aborted: boolean) => {
            if (recorded) return;
            recorded = true;
            // A 302 can also be an OAuth rejection; a redirect alone is not consent.
            let approved = false;
            let redirectRejected = false;
            const location = res.getHeader("location");
            if (endpoint === "authorize" && typeof location === "string") {
                try {
                    const callback = new URL(location);
                    approved = res.statusCode === 302 && callback.searchParams.has("code") && !callback.searchParams.has("error");
                    redirectRejected = callback.searchParams.has("error");
                } catch { /* No location or query data is copied into diagnostics. */ }
            }
            const event: OAuthDiagnosticEvent = {
                at: new Date().toISOString(), endpoint, method, status: res.statusCode,
                outcome: aborted ? "aborted" : endpoint === "mcp" && res.statusCode === 401 ? "challenge" : res.statusCode >= 400 || redirectRejected ? "rejected" : approved ? "approved" : "responded",
                platform, browser,
            };
            this.events.push(event);
            if (this.events.length > MAX_EVENTS) this.events.shift();
            writeRuntimeLog(event.status >= 500 ? "error" : "info", "oauth_http_response", {
                endpoint, method, status: event.status, outcome: event.outcome, platform, browser,
            });
        };
        res.once("finish", () => record(false));
        res.once("close", () => record(!res.writableFinished));
    };
}

export function describeOAuthDiagnostics(snapshot: OAuthDiagnosticsSnapshot): string {
    const names: Record<OAuthDiagnosticEvent["endpoint"], string> = {
        mcp: "MCP 请求", resource_metadata: "资源发现", authorization_metadata: "授权发现",
        register: "客户端注册", authorize: "授权页面", token: "令牌交换", revoke: "撤销授权",
    };
    if (!snapshot.events.length) return "本次服务启动后尚未收到连接请求。";
    return snapshot.events.slice(-8).map(event => `${event.at.slice(11, 19)} UTC ${names[event.endpoint]} ${event.method} ${event.status}${event.outcome === "approved" ? "（已授权）" : event.outcome === "challenge" ? "（需要授权）" : event.outcome === "rejected" ? "（已拒绝）" : event.outcome === "aborted" ? "（中断）" : ""}${event.platform === "macos" ? " [Mac]" : event.platform === "windows" ? " [Windows]" : ""}`).join("；");
}
