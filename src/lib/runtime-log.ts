import { once } from "node:events";
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Level, type Logger } from "pino";
import { ensureUserConfigDirs, getUserLogDir } from "../config/user-config.js";
import { ensurePrivateDirectory } from "./fs/private-directory.js";

const LOG_FILE_NAME = "codex-mcp.jsonl";
const LOG_MAX_VALUE_LENGTH = 1_000;
const SENSITIVE_FIELD_RE =
    /authorization|cookie|credential|password|private.?key|secret|token/i;
const SAFE_STRING_FIELDS: Record<string, RegExp> = {
    endpoint: /^(mcp|resource_metadata|authorization_metadata|register|authorize|token|revoke)$/,
    outcome: /^(responded|approved|challenge|rejected|aborted)$/,
    platform: /^(macos|windows|other|unknown)$/,
    browser: /^(chrome|safari|edge|firefox|other|unknown)$/,
    invocationId: /^[a-f0-9-]{36}$/,
    tool: /^[a-z][a-z0-9_]{0,63}$/,
    project: /^[a-f0-9]{64}$/,
    mode: /^(local|public)$/,
    method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/,
    failure: /^(handler_threw|tool_error)$/,
    reason: /^(Error|TypeError|SyntaxError|RangeError|AbortError|AggregateError|unknown)$/,
    grantKind: /^(authorization_code|refresh_token|other)$/,
    oauthErrorCode: /^(invalid_request|invalid_client|invalid_grant|invalid_scope|invalid_target|unsupported_grant_type|server_error|temporarily_unavailable)$/,
};

type RuntimeLogValue = string | number | boolean | null | undefined;
type RuntimeLogFields = Record<string, RuntimeLogValue>;
type RuntimeTransport = ReturnType<typeof pino.transport>;

interface RuntimeLogState {
    directory: string;
    failed: boolean;
    logger?: Logger;
    onError?: (error: Error) => void;
    transport: RuntimeTransport;
    warned: boolean;
}

export interface RuntimeLogInfo {
    directory: string;
    pattern: string;
}

export interface RuntimeLogOptions {
    directory?: string;
    onError?: (error: Error) => void;
}

let state: RuntimeLogState | undefined;

/** Start the process-wide rotating JSONL logger. Safe to call more than once. */
export async function initializeRuntimeLog(
    options: RuntimeLogOptions = {},
): Promise<RuntimeLogInfo> {
    if (state) return logInfo(state.directory);

    const directory = options.directory ?? getUserLogDir();
    ensureUserConfigDirs();
    ensurePrivateDirectory(directory);
    // Repair the permissions of earlier log generations before reusing them.
    for (const name of readdirSync(directory)) {
        if (!/^codex-mcp(?:\.[\w-]+)*\.jsonl$/.test(name)) continue;
        const path = join(directory, name);
        const file = lstatSync(path);
        if (!file.isFile() || (process.getuid && file.uid !== process.getuid())) {
            throw new Error("运行日志必须是当前用户拥有的普通文件。");
        }
        if (process.platform !== "win32") chmodSync(path, 0o600);
    }
    const transport = pino.transport({
        target: "pino-roll",
        options: {
            file: join(directory, LOG_FILE_NAME),
            frequency: "daily",
            size: "10m",
            dateFormat: "yyyy-MM-dd",
            mkdir: true,
            mode: 0o600,
            limit: {
                count: 7,
                removeOtherLogFiles: true,
            },
        },
    });
    const pending: RuntimeLogState = {
        directory,
        failed: false,
        ...(options.onError ? { onError: options.onError } : {}),
        transport,
        warned: false,
    };
    transport.on("error", (error: Error) => handleTransportError(pending, error));

    try {
        await once(transport, "ready");
        pending.logger = pino(
            {
                base: { service: "aimcp" },
                timestamp: pino.stdTimeFunctions.isoTime,
                redact: {
                    paths: [
                        "authorization",
                        "cookie",
                        "credential",
                        "password",
                        "privateKey",
                        "secret",
                        "token",
                    ],
                    remove: true,
                },
            },
            transport,
        );
        state = pending;
        return logInfo(directory);
    } catch (error) {
        transport.end();
        throw error;
    }
}

/** Write one bounded structured runtime event when file logging is available. */
export function writeRuntimeLog(
    level: Level,
    event: string,
    fields: RuntimeLogFields = {},
): void {
    const current = state;
    if (!current?.logger || current.failed) return;
    current.logger[level]({
        ...sanitizeRuntimeLogFields(fields),
        event: clipText(event),
    });
}

/** Flush pending JSON lines and stop the transport during process shutdown. */
export function closeRuntimeLog(): void {
    const current = state;
    state = undefined;
    if (!current) return;

    try {
        current.transport.flushSync();
    } finally {
        current.transport.end();
    }
}

export function getRuntimeLogInfo(): RuntimeLogInfo | undefined {
    return state ? logInfo(state.directory) : undefined;
}

function logInfo(directory: string): RuntimeLogInfo {
    return {
        directory,
        pattern: join(directory, "codex-mcp.*.jsonl"),
    };
}

/** Free-form strings are never safe for ordinary diagnostic logs. */
export function sanitizeRuntimeLogFields(fields: RuntimeLogFields): Record<string, RuntimeLogValue> {
    const safe: Record<string, RuntimeLogValue> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || SENSITIVE_FIELD_RE.test(key)) continue;
        if (typeof value === "string") {
            if (SAFE_STRING_FIELDS[key]?.test(value)) safe[key] = value;
        } else if (typeof value === "boolean" || value === null ||
            (typeof value === "number" && Number.isFinite(value))) {
            safe[key] = value;
        }
    }
    return safe;
}

function clipText(value: string): string {
    return value.length <= LOG_MAX_VALUE_LENGTH
        ? value
        : `${value.slice(0, LOG_MAX_VALUE_LENGTH)}…`;
}

function handleTransportError(current: RuntimeLogState, error: Error): void {
    current.failed = true;
    if (state !== current || current.warned) return;
    current.warned = true;
    current.onError?.(error);
}
