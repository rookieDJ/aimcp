import { z } from "zod";
import { isConversationRecordingEnabled } from "../config/user-config.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { RegisteredProject } from "../daemon/state.js";
import { registerTool } from "../lib/tool/log.js";
import { stateWriteAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { canonicalProjectPath } from "../projects/identity.js";
import { projectSessionHandle, type BindingStore } from "../projects/bindings.js";
import { ensureToolConversationOwner } from "../lib/tool/context.js";
import { archiveProjectBindings, assertConversationClient, chatMessageSchema, conversationClientSchema, saveConversationUse, type ConversationClient } from "../projects/conversations.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { ProjectRuntimeManager } from "../projects/runtime.js";
import { currentBindingOwnerKey, unboundProjectMessage } from "../server/project-router.js";

export interface ProjectToolDeps {
    registry: ProjectRegistry;
    bindings: BindingStore;
    runtimes: ProjectRuntimeManager;
    fallbackOwnerId: string;
}

const projectSchema = z.object({
    id: z.string(), name: z.string(), path: z.string(), active: z.boolean(), lastSeenAt: z.string(),
});
const bindingSchema = z.object({
    ownerKey: z.string(), projectId: z.string(), boundAt: z.string(), lastSeenAt: z.string(),
    client: conversationClientSchema.optional(),
});

function publicProject(project: RegisteredProject) {
    return { id: project.id, name: project.name, path: project.path, active: project.active, lastSeenAt: project.lastSeenAt };
}

export function registerProjectTools(server: McpServer, deps: ProjectToolDeps): void {
    const { registry, bindings, runtimes, fallbackOwnerId } = deps;
    registerTool(server, "project_control", withToolAuth({
        title: "Manage conversation project",
        description: "List/select/current/unbind the conversation project, or record user-visible chat messages locally. On select identify client as chatgpt, gemini or other. Retain project_session on every later call; never share it between chats or clients. With action=record send visible user/assistant messages using stable unique message ids (retry-safe), optional title, at most 20 messages / 48 KB per batch. If recording_enabled=false, stop uploading chat until enabled locally. Only supplied messages are saved; never fabricate missing chat or send hidden reasoning/system prompts. Confirm before switching projects; force=true only after confirmation.",
        inputSchema: {
            action: z.enum(["list", "select", "current", "unbind", "record"]),
            project_id: z.string().min(1).max(256).optional(),
            project_path: z.string().max(2_000).optional(),
            force: z.boolean().optional(),
            client: conversationClientSchema.optional(),
            title: z.string().min(1).max(200).optional(),
            messages: z.array(chatMessageSchema).min(1).max(20).optional(),
        },
        outputSchema: {
            action: z.enum(["list", "select", "current", "unbind", "record"]),
            projects: z.array(projectSchema), binding: bindingSchema.nullable(),
            project: projectSchema.nullable(), workspaceRoots: z.array(z.string()),
            project_session: z.string().nullable(),
            recording_enabled: z.boolean(),
            saved_messages: z.number().optional(),
            message_count: z.number().optional(),
        },
        annotations: stateWriteAnnotations,
    }), async ({ action, project_id: projectId, project_path: projectPath, force, client, title, messages }) => {
        try {
            if (action !== "select" && (projectId !== undefined || projectPath !== undefined || force !== undefined)) throw new Error("project_id、project_path 和 force 仅适用于 action=select。");
            if (action !== "record" && (messages !== undefined || title !== undefined)) throw new Error("messages 和 title 仅适用于 action=record。");
            if (action !== "select" && action !== "record" && client !== undefined) throw new Error("client 仅适用于 action=select 或 record。");
            if (action === "select") await bindProject(deps, projectId, projectPath, force, client);
            else if (action === "unbind") await unbindProject(deps, currentBindingOwnerKey(fallbackOwnerId));

            const binding = bindings.resolve(currentBindingOwnerKey(fallbackOwnerId)) ?? null;
            const selected = binding ? registry.getActiveById(binding.projectId) : undefined;
            const runtime = selected && runtimes.has(selected.id) ? runtimes.get(selected.id, selected.path) : undefined;
            const projects = registry.listActive().map(publicProject).sort((a, b) => a.name.localeCompare(b.name));
            const handle = binding && selected ? projectSessionHandle(binding.ownerKey) : null;
            let recordingEnabled = isConversationRecordingEnabled();
            let recorded: { saved_messages: number; message_count?: number } | undefined;
            if (action === "record") {
                if (!binding || !selected) throw new Error("请先绑定项目，再携带 project_session 保存此会话的聊天内容。");
                if (!messages?.length) throw new Error("action=record 需要 messages。");
                const category = assertConversationClient(binding.ownerKey, client, binding.client);
                const result = await saveConversationUse(binding.ownerKey, selected, { client: category, title, messages, boundAt: binding.boundAt });
                recordingEnabled = result.recordingEnabled;
                recorded = { saved_messages: result.saved, ...(recordingEnabled ? { message_count: result.messageCount } : {}) };
            }
            const status = action === "select" && selected
                ? `当前会话已绑定项目 ${selected.name}（${selected.id}）。`
                : action === "record" && !recordingEnabled ? "本地会话保存已关闭，本次消息未保存。请停止发送聊天内容，直到用户在本机重新开启保存。"
                : action === "record" ? `已保存 ${recorded!.saved_messages} 条新消息；此会话本地共 ${recorded!.message_count} 条消息（仅包含客户端实际发送的内容）。`
                : action === "unbind" ? "已取消当前会话的项目绑定，本地会话历史保留。"
                : selected ? `当前绑定项目 ${selected.name}（${selected.id}），共有 ${projects.length} 个活动项目。`
                : unboundProjectMessage(registry.listActive());
            const text = handle ? `${status}\n后续所有工具调用必须携带 project_session="${handle}"，以便在重连或客户端会话标识变化后继续使用当前项目。` : status;
            return okResult(text, { action, projects, binding, project: selected ? publicProject(selected) : null, workspaceRoots: runtime ? [...runtime.project.roots] : [], project_session: handle, recording_enabled: recordingEnabled, ...recorded });
        } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
        }
    });
}

async function bindProject(deps: ProjectToolDeps, projectId?: string, projectPath?: string, force?: boolean, client?: ConversationClient): Promise<void> {
    const hasId = Boolean(projectId?.trim());
    const hasPath = Boolean(projectPath?.trim());
    if (hasId === hasPath) throw new Error("action=select 需要且只需要 project_id 或 project_path。");
    const selected = hasId ? deps.registry.getActiveById(projectId!.trim()) : selectByPath(deps.registry, projectPath!.trim());
    if (!selected) throw new Error("没有找到指定的活动项目。");
    const ownerKey = ensureToolConversationOwner(deps.fallbackOwnerId);
    const existing = deps.bindings.resolve(ownerKey);
    const category = assertConversationClient(ownerKey, client, existing?.client);
    if (existing && existing.projectId !== selected.id && force !== true) {
        throw new Error("这个会话已经绑定其他项目；用户确认切换后请传 force=true。");
    }
    if (existing && existing.projectId !== selected.id) {
        const previous = deps.registry.getById(existing.projectId);
        if (previous) await archiveProjectBindings(previous, [existing]);
        await deps.runtimes.shutdownOwner(existing.projectId, ownerKey);
    }
    deps.runtimes.get(selected.id, selected.path);
    await deps.bindings.bind(ownerKey, selected.id, category);
    const binding = deps.bindings.resolve(ownerKey)!;
    await saveConversationUse(ownerKey, selected, { client: category, boundAt: binding.boundAt });
}

async function unbindProject(deps: ProjectToolDeps, ownerKey: string): Promise<void> {
    const existing = deps.bindings.resolve(ownerKey);
    const previous = existing ? deps.registry.getById(existing.projectId) : undefined;
    if (existing && previous) await archiveProjectBindings(previous, [existing]);
    if (existing) await deps.runtimes.shutdownOwner(existing.projectId, ownerKey);
    await deps.bindings.unbind(ownerKey);
}

function selectByPath(registry: ProjectRegistry, path: string): RegisteredProject | undefined {
    const direct = registry.getByPath(path);
    if (direct?.active) return direct;
    try {
        const canonical = registry.getByPath(canonicalProjectPath(path));
        return canonical?.active ? canonical : undefined;
    } catch {
        return undefined;
    }
}
