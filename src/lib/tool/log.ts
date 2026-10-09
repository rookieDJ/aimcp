import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { toolUiMeta } from "../../ui/register-ui.js";
import { securitySchemesForServer } from "./meta.js";
import { buildUiCard } from "../../ui/ui-card.js";
import { errorResult, resultText } from "./result.js";
import { runtimeTelemetry } from "../util/telemetry.js";
import { sanitizeRuntimeLogFields, writeRuntimeLog } from "../runtime-log.js";
import { printCompactLog } from "../util/terminal.js";
import { runWithToolInvocationContext, setToolProjectOwner } from "./context.js";

const TOOL_NAME_WIDTH = 18;
const toolRegistrationPolicies = new WeakMap<McpServer, ReadonlySet<string>>();
const projectSessionResolvers = new WeakMap<McpServer, (handle: string) => string | undefined>();
const contextObservers = new WeakMap<McpServer, (bytes: number) => boolean>();

export function configureToolContextObserver(server: McpServer, observe: (bytes: number) => boolean): void {
    contextObservers.set(server, observe);
}

export function configureToolProjectSessions(
    server: McpServer,
    resolve: (handle: string) => string | undefined,
): void {
    projectSessionResolvers.set(server, resolve);
}

export function isToolLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.CODING_MCP_LOG_TOOLS;
    if (raw === undefined) return true;
    return raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Current local time as HH:mm:ss.
 *
 * @returns Time label
 */
function timeLabel(): string {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Format elapsed time for a compact log column.
 *
 * @param durationMs - Elapsed milliseconds
 * @returns Short duration string
 */
function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs}ms`;
    const seconds = durationMs / 1000;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    return `${Math.round(seconds)}s`;
}

/**
 * Pad a tool name for column alignment.
 *
 * @param toolName - Tool name
 * @returns Padded name
 */
function padToolName(toolName: string): string {
    return toolName.padEnd(TOOL_NAME_WIDTH);
}

/**
 * Log a notable MCP lifecycle warning (routine initialize/session are silent).
 *
 * @param kind - Short event label, e.g. session_miss
 * @param details - Compact key/value details
 */
export function logMcpEvent(kind: string, details: Record<string, unknown> = {}): void {
    if (!isToolLogEnabled()) return;

    const pairs = Object.entries(sanitizeRuntimeLogFields(primitiveLogFields(details)))
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${String(value)}`);
    const detail = pairs.join(" ");
    printCompactLog(
        "warning",
        `${timeLabel()}  ${kind.padEnd(TOOL_NAME_WIDTH)}  ${detail}`.trimEnd(),
    );
    writeRuntimeLog("warn", kind, primitiveLogFields(details));
}

/**
 * Write one compact colored tool-call log line.
 *
 * @param toolName - Tool name
 * @param result - Tool result or an error flag; payloads never enter logs
 * @param durationMs - Elapsed milliseconds
 */
function logToolCall(
    toolName: string,
    result: CallToolResult | { thrown: true },
    durationMs: number,
    invocationId: string,
): void {
    if (!isToolLogEnabled()) return;

    const time = timeLabel();
    const tool = padToolName(toolName);
    const ms = formatDuration(durationMs).padStart(5);
    const ok = !("thrown" in result) && !result.isError;
    const outcome = "thrown" in result ? "执行异常" : ok ? "完成" : "失败";
    // The terminal can be captured by another logger; never copy arguments,
    // output or error text here. Rich summaries remain in the tool response.
    printCompactLog("thrown" in result ? "error" : ok ? "success" : "warning", `${time}  ${tool}  ${ms}  ${outcome}`);
    writeRuntimeLog("thrown" in result ? "error" : ok ? "info" : "warn", "tool_call", {
        invocationId,
        tool: toolName,
        durationMs,
        ok,
        ...(ok ? {} : { failure: "thrown" in result ? "handler_threw" : "tool_error" }),
    });
}

function primitiveLogFields(
    details: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(details)) {
        if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            value === null
        ) {
            fields[key] = value;
        }
    }
    return fields;
}

/** Configure the concrete tool set exposed by one MCP server/session. */
export function configureToolRegistrationPolicy(
    server: McpServer,
    allowedTools?: ReadonlySet<string>,
): void {
    if (allowedTools === undefined) {
        toolRegistrationPolicies.delete(server);
        return;
    }
    toolRegistrationPolicies.set(server, allowedTools);
}

/**
 * Register a tool on the MCP server with centralized call logging.
 *
 * @param server - MCP server
 * @param name - Tool name
 * @param config - Tool config (schemas, annotations, …)
 * @param handler - Tool handler (args shaped by inputSchema at runtime)
 */
export function registerTool(
    server: McpServer,
    name: string,
    config: object,
    // Args are validated by the SDK from inputSchema; keep handler ergonomics simple.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<CallToolResult>,
): void {
    const allowedTools = toolRegistrationPolicies.get(server);
    if (allowedTools && !allowedTools.has(name)) return;

    const previousMeta =
        config && typeof config === "object" && "_meta" in config
            ? ((config as { _meta?: Record<string, unknown> })._meta ?? {})
            : {};
    const securitySchemes = securitySchemesForServer(server);
    const generatedUiMeta = toolUiMeta(server, name);
    const previousUi =
        previousMeta.ui && typeof previousMeta.ui === "object"
            ? (previousMeta.ui as Record<string, unknown>)
            : undefined;
    const generatedUi =
        generatedUiMeta.ui && typeof generatedUiMeta.ui === "object"
            ? (generatedUiMeta.ui as Record<string, unknown>)
            : undefined;
    const mergedUi =
        previousUi || generatedUi
            ? { ...(previousUi ?? {}), ...(generatedUi ?? {}) }
            : undefined;
    const sourceConfig = config as Record<string, unknown>;
    const inputSchema = sourceConfig.inputSchema && typeof sourceConfig.inputSchema === "object"
        ? sourceConfig.inputSchema as Record<string, unknown>
        : {};
    const resolveProjectSession = projectSessionResolvers.get(server);
    const configWithUi = {
        ...sourceConfig,
        inputSchema: {
            purpose: z.string().max(80).describe(
                "Short user-visible summary of what this call will obtain, verify, or change.",
            ),
            ...inputSchema,
            ...(resolveProjectSession ? {
                project_session: z.string().regex(/^[a-f0-9]{64}$/).optional().describe(
                    "Stable handle returned by project_control(select). Pass it on every subsequent tool call in this conversation, including after reconnecting or when client session metadata is absent.",
                ),
            } : {}),
        },
        securitySchemes,
        _meta: {
            ...previousMeta,
            securitySchemes,
            ...generatedUiMeta,
            ...(mergedUi ? { ui: mergedUi } : {}),
        },
    };

    const wrapped = async (
        args: Record<string, unknown>,
        context: ServerContext,
    ): Promise<CallToolResult> => {
        return await runWithToolInvocationContext(context, async () => {
            const startedAt = performance.now();
            const invocationId = randomUUID();
            if (isToolLogEnabled()) {
                writeRuntimeLog("info", "tool_call_started", {
                    invocationId,
                    tool: name,
                });
            }
            try {
                const executionArgs = { ...args };
                delete executionArgs.purpose;
                delete executionArgs.project_session;
                let sessionError: CallToolResult | undefined;
                if (resolveProjectSession && typeof args.project_session === "string") {
                    const ownerId = resolveProjectSession(args.project_session);
                    if (ownerId) setToolProjectOwner(ownerId);
                    else sessionError = errorResult("project_session 已失效或不属于当前连接。请在用户确认的项目上重新调用 project_control(action=select)，并在后续调用中携带返回的 project_session。");
                }
                let raw = sessionError ?? await handler(executionArgs);
                if (!raw.isError && name !== "project_control" && contextObservers.get(server)?.(estimateResultBytes(raw))) {
                    raw = { ...raw, content: [...(raw.content ?? []), { type: "text", text: "长任务检查点提醒：本会话已产生较多 MCP 调用或输出（不是模型 token 用量）。请用 project_control(action=checkpoint, project_session, checkpoint={id,summary,next_steps,previous_id}) 保存精简任务状态；首次 previous_id=null，更新前 restore 读取上一份 id。勿包含凭据或隐藏推理。需要恢复时调用 action=restore。此工具不能清空 Gemini App 的上下文。" }] };
                }
                const result = withUiCardMeta(name, args, raw);
                const durationMs = performance.now() - startedAt;
                runtimeTelemetry.recordTool(
                    name,
                    durationMs,
                    result.isError === true,
                    estimateResultBytes(result),
                );
                logToolCall(name, result, Math.round(durationMs), invocationId);
                return result;
            } catch (error) {
                const durationMs = performance.now() - startedAt;
                runtimeTelemetry.recordTool(name, durationMs, true, 0);
                logToolCall(
                    name,
                    { thrown: true },
                    Math.round(durationMs),
                    invocationId,
                );
                throw error;
            }
        });
    };

    // SDK overloads are wide; keep a single registration path here.
    (
        server.registerTool as (
            toolName: string,
            conf: object,
            fn: (args: Record<string, unknown>, context: ServerContext) => Promise<CallToolResult>,
        ) => void
    )(name, configWithUi, wrapped);
}

/**
 * Attach `_meta.uiCard` summary for the ChatGPT iframe. Full bodies stay in
 * structuredContent for the model; the widget only reads uiCard.
 *
 * @param toolName - Tool name
 * @param args - Original tool arguments (drives collapsed title)
 * @param result - Raw tool result
 * @returns Result with compact `_meta.uiCard`
 */
function estimateResultBytes(result: CallToolResult): number {
    try {
        return Buffer.byteLength(
            JSON.stringify({
                isError: result.isError === true,
                content: result.content,
                structuredContent: result.structuredContent,
            }),
            "utf8",
        );
    } catch {
        return 0;
    }
}

function withUiCardMeta(
    toolName: string,
    args: Record<string, unknown>,
    result: CallToolResult,
): CallToolResult {
    const structured =
        result.structuredContent && typeof result.structuredContent === "object"
            ? (result.structuredContent as Record<string, unknown>)
            : null;
    const uiCard = buildUiCard(
        toolName,
        !result.isError,
        args,
        structured,
        resultText(result),
    );
    const previousMeta =
        result._meta && typeof result._meta === "object"
            ? (result._meta as Record<string, unknown>)
            : {};

    return {
        ...result,
        _meta: {
            ...previousMeta,
            tool: toolName,
            uiCard,
        },
    };
}
