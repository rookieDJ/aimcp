import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getUserConfigDir, isConversationRecordingEnabled } from "../config/user-config.js";
import type { RegisteredProject, SessionBinding } from "../daemon/state.js";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";
import { ensurePrivateDirectory } from "../lib/fs/private-directory.js";

export const conversationClientSchema = z.enum(["chatgpt", "gemini", "other"]);
export const chatMessageSchema = z.object({
    id: z.string().min(1).max(128),
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(16_000),
    timestamp: z.iso.datetime().optional(),
}).strict();
const projectUseSchema = z.object({ projectId: z.string(), projectName: z.string(), firstSeenAt: z.iso.datetime(), lastSeenAt: z.iso.datetime() }).strict();
const archiveSchema = z.object({
    schemaVersion: z.literal(1), id: z.string().regex(/^[a-f0-9]{32}$/), client: conversationClientSchema,
    title: z.string().max(200).optional(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
    projects: z.array(projectUseSchema), messages: z.array(chatMessageSchema),
}).strict();
export type ConversationClient = z.infer<typeof conversationClientSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ConversationArchive = z.infer<typeof archiveSchema>;
export const clientLabel = (client: ConversationClient): string => client === "chatgpt" ? "ChatGPT" : client === "gemini" ? "Gemini" : "未识别客户端";
export const conversationId = (ownerKey: string): string => createHash("sha256").update(ownerKey).digest("hex").slice(0, 32);
const archiveDir = (): string => join(homedir(), ".codex-mcp", "conversations");
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

function archivePath(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("会话编号无效。");
    return join(archiveDir(), `${id}.json`);
}

export function readConversation(id: string): ConversationArchive | undefined {
    const path = archivePath(id);
    if (readDeletion(id)) return undefined;
    try {
        if (statSync(path).size > MAX_ARCHIVE_BYTES) throw new Error("oversized");
        const record = archiveSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        if (record.id !== id) throw new Error("id mismatch");
        return record;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        // Never include parser diagnostics or message content in normal logs/errors.
        throw new Error("本地会话记录无法读取，请检查记录文件。");
    }
}


const deletionSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-f0-9]{32}$/), client: conversationClientSchema }).strict();
const deletionPath = (id: string): string => `${archivePath(id)}.deleted`;
function readDeletion(id: string): z.infer<typeof deletionSchema> | undefined {
    try {
        const marker = deletionSchema.parse(JSON.parse(readFileSync(deletionPath(id), "utf8")));
        if (marker.id !== id) throw new Error("id mismatch");
        return marker;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("本地会话删除状态无法读取，请检查记录文件。");
    }
}
export function conversationClientForId(id: string): ConversationClient | undefined {
    return readConversation(id)?.client ?? readDeletion(id)?.client;
}

async function withConversationLock<T>(id: string, run: () => T): Promise<T> {
    const path = archivePath(id);
    ensurePrivateDirectory(getUserConfigDir());
    ensurePrivateDirectory(archiveDir());
    const lockPath = `${path}.lock`;
    const lockValue = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    const deadline = Date.now() + 5_000;
    while (true) {
        try {
            const fd = openSync(lockPath, "wx", 0o600);
            try { writeFileSync(fd, lockValue); } finally { closeSync(fd); }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("无法保存本地会话记录。");
            // Recover only a lock whose recorded process is proven to have exited.
            try {
                const value = readFileSync(lockPath, "utf8");
                const lock = JSON.parse(value) as { pid: number };
                if (Number.isSafeInteger(lock.pid) && lock.pid > 0) {
                    try { process.kill(lock.pid, 0); }
                    catch (probeError) {
                        if ((probeError as NodeJS.ErrnoException).code === "ESRCH" && readFileSync(lockPath, "utf8") === value) unlinkSync(lockPath);
                    }
                }
            } catch { /* A live writer can still be initializing its lock. */ }
            if (Date.now() >= deadline) throw new Error("本地会话正在保存，请重试。");
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
    try { return run(); } finally {
        if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === lockValue) unlinkSync(lockPath);
    }
}


/** Erase the whole conversation across projects; retain only its client category. */
export async function deleteConversation(id: string, fallbackClient: ConversationClient = "other"): Promise<{ deleted: boolean }> {
    return await withConversationLock(id, () => {
        const previous = readDeletion(id);
        const client = conversationClientForId(id) ?? fallbackClient;
        writePrivateFileAtomic(deletionPath(id), JSON.stringify({ schemaVersion: 1, id, client }));
        let deleted = previous === undefined;
        try { unlinkSync(archivePath(id)); deleted = true; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                if (previous) writePrivateFileAtomic(deletionPath(id), JSON.stringify(previous));
                else unlinkSync(deletionPath(id));
                throw new Error("删除本地聊天记录失败，请检查文件权限后重试。");
            }
        }
        return { deleted };
    });
}

export function assertConversationClient(ownerKey: string, requested?: ConversationClient, boundClient?: ConversationClient): ConversationClient {
    const priorClient = conversationClientForId(conversationId(ownerKey));
    const inferred: ConversationClient = ownerKey.includes("|openai-session:") ? "chatgpt" : "other";
    const client = requested ?? (priorClient && priorClient !== "other" ? priorClient : boundClient ?? priorClient) ?? inferred;
    if ((priorClient && priorClient !== "other" && client !== priorClient) || (boundClient && boundClient !== "other" && client !== boundClient) || (inferred === "chatgpt" && client !== "chatgpt")) {
        throw new Error("此会话已属于其他客户端，请为 GPT 和 Gemini 分别选择项目，勿复用 project_session。");
    }
    return client;
}

/** Separate from routing state: an archive never grants access or restores a binding. */
export async function saveConversationUse(ownerKey: string, project: RegisteredProject, options: {
    client?: ConversationClient; title?: string; messages?: ChatMessage[]; boundAt: string; lastSeenAt?: string; preserveDeletion?: boolean;
}): Promise<{ id: string; saved: number; messageCount: number; recordingEnabled: boolean }> {
    const id = conversationId(ownerKey);
    const path = archivePath(id);
    const paused = { id, saved: 0, messageCount: 0, recordingEnabled: false };
    if (!isConversationRecordingEnabled()) return paused;
    return await withConversationLock(id, () => {
        // Re-read after waiting for another process; the running Runtime need not restart.
        if (!isConversationRecordingEnabled()) return paused;
        if (options.preserveDeletion && readDeletion(id)) return { id, saved: 0, messageCount: 0, recordingEnabled: true };
        const now = new Date().toISOString();
        const firstSeenAt = readDeletion(id) ? now : options.boundAt;
        const client = assertConversationClient(ownerKey, options.client);
        const record = readConversation(id) ?? { schemaVersion: 1 as const, id, client, createdAt: firstSeenAt, updatedAt: now, projects: [], messages: [] };
        const messages = (options.messages ?? []).map(message => chatMessageSchema.parse(message));
        if (messages.length > 20 || Buffer.byteLength(JSON.stringify(messages)) > 48 * 1024) throw new Error("每次最多保存 20 条消息、48 KB，请分批发送。");
        const known = new Map(record.messages.map(message => [message.id, message]));
        let saved = 0;
        for (const message of messages) {
            const prior = known.get(message.id);
            if (prior) {
                if (prior.role !== message.role || prior.content !== message.content || prior.timestamp !== message.timestamp) throw new Error("消息编号已存在且内容不同，请使用新的消息编号。");
            } else { record.messages.push(message); known.set(message.id, message); saved++; }
        }
        record.client = client;
        if (options.title !== undefined) record.title = z.string().min(1).max(200).parse(options.title);
        const use = record.projects.find(item => item.projectId === project.id);
        const lastSeenAt = options.lastSeenAt ?? now;
        if (use) { use.projectName = project.name; use.lastSeenAt = lastSeenAt > use.lastSeenAt ? lastSeenAt : use.lastSeenAt; }
        else record.projects.push({ projectId: project.id, projectName: project.name, firstSeenAt, lastSeenAt });
        record.updatedAt = now;
        const content = JSON.stringify(archiveSchema.parse(record), null, 2);
        if (record.messages.length > 10_000 || Buffer.byteLength(content) > MAX_ARCHIVE_BYTES) throw new Error("此会话记录已达本地保存上限（8 MB / 10000 条）；请开始新会话。");
        writePrivateFileAtomic(path, content);
        try { unlinkSync(deletionPath(id)); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("聊天已保存，但清理删除标记失败，请检查本地文件权限。");
        }
        return { id, saved, messageCount: record.messages.length, recordingEnabled: true };
    });
}

export async function archiveProjectBindings(project: RegisteredProject, bindings: SessionBinding[]): Promise<void> {
    for (const binding of bindings) {
        if (binding.projectId === project.id) await saveConversationUse(binding.ownerKey, project, { client: binding.client, boundAt: binding.boundAt, lastSeenAt: binding.lastSeenAt, preserveDeletion: true });
    }
}

export function listConversationRecords(bindings: SessionBinding[], projects: RegisteredProject[]) {
    const recordingEnabled = isConversationRecordingEnabled();
    const records: ConversationArchive[] = [];
    let unavailable = 0;
    let names: string[];
    try { names = readdirSync(archiveDir()); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取本地会话记录目录。");
        names = [];
    }
    for (const name of names) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        try { const record = readConversation(name.slice(0, -5)); if (record) records.push(record); }
        catch { unavailable++; }
    }
    // Existing installations have live bindings but no archives yet.
    for (const binding of recordingEnabled ? bindings : []) {
        const id = conversationId(binding.ownerKey);
        try { if (readDeletion(id)) continue; } catch { unavailable++; continue; }
        if (!records.some(record => record.id === id)) records.push({ schemaVersion: 1, id, client: binding.client ?? (binding.ownerKey.includes("|openai-session:") ? "chatgpt" : "other"), createdAt: binding.boundAt, updatedAt: binding.lastSeenAt, projects: [], messages: [] });
        const record = records.find(record => record.id === id)!;
        if (!record.projects.some(use => use.projectId === binding.projectId)) record.projects.push({ projectId: binding.projectId, projectName: projects.find(project => project.id === binding.projectId)?.name ?? "已移除项目", firstSeenAt: binding.boundAt, lastSeenAt: binding.lastSeenAt });
    }
    return { unavailable, records: records.flatMap(record => record.projects.map(use => {
        const binding = bindings.find(item => conversationId(item.ownerKey) === record.id && item.projectId === use.projectId);
        return { id: record.id, client: record.client, label: clientLabel(record.client), title: record.title,
            ...use, bound: Boolean(binding), registered: projects.some(project => project.id === use.projectId),
            lastSeenAt: recordingEnabled && binding && binding.lastSeenAt > use.lastSeenAt ? binding.lastSeenAt : use.lastSeenAt,
            messageCount: record.messages.length };
    })).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)) };
}
