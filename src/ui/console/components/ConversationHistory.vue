<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api, friendlyError, type ConversationRecord, type ConversationTranscript } from "../api.js";

const props = defineProps<{ records: ConversationRecord[]; unavailable: number; recordingEnabled: boolean; recordingReady: boolean; busy: boolean }>();
const emit = defineEmits<{ delete: [record: ConversationRecord]; recordingChange: [enabled: boolean] }>();
const projectId = defineModel<string>("projectId", { default: "" });
const client = ref("all");
const root = ref<HTMLElement>();
const open = ref(false);
const selected = ref<ConversationRecord>();
const transcript = ref<ConversationTranscript>();
const loading = ref(false);
const error = ref("");
let request: AbortController | undefined;
const projectOptions = computed(() => [...new Map(props.records.map(item => [item.projectId, { id: item.projectId, name: item.projectName, registered: item.registered }])).values()]);
const visibleRecords = computed(() => props.records.filter(item => (!projectId.value || item.projectId === projectId.value) && (client.value === "all" || item.client === client.value)));
const formatTime = (time: string): string => new Date(time).toLocaleString("zh-CN");

async function load(record: ConversationRecord): Promise<void> {
    request?.abort();
    const owner = new AbortController();
    request = owner;
    error.value = "";
    loading.value = true;
    try {
        const result = await api<{ conversation: ConversationTranscript }>(`/api/conversations/${encodeURIComponent(record.id)}`, { signal: owner.signal });
        if (!owner.signal.aborted && request === owner) transcript.value = result.conversation;
    } catch (reason) {
        if (!owner.signal.aborted && request === owner) error.value = friendlyError(reason);
    } finally {
        if (request === owner) loading.value = false;
    }
}
function show(record: ConversationRecord): void {
    request?.abort();
    request = undefined;
    loading.value = false;
    error.value = "";
    selected.value = record;
    transcript.value = undefined;
    open.value = true;
    if (record.messageCount || record.checkpointAt) void load(record);
}
function showById(id: string): void {
    const record = props.records.find(item => item.id === id);
    if (record) show(record);
}
function focusProject(id: string): void {
    projectId.value = id;
    client.value = "all";
    root.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}
watch(open, value => {
    if (!value) { request?.abort(); request = undefined; loading.value = false; selected.value = undefined; transcript.value = undefined; }
});
watch(() => props.records, records => {
    if (projectId.value && !records.some(item => item.projectId === projectId.value)) projectId.value = "";
    if (!open.value || !selected.value) return;
    const next = records.find(item => item.id === selected.value!.id && item.projectId === selected.value!.projectId);
    if (!next) { open.value = false; return; }
    if (next) {
        const changed = next.messageCount !== selected.value.messageCount || next.checkpointAt !== selected.value.checkpointAt;
        selected.value = next;
        if (changed && (next.messageCount || next.checkpointAt)) void load(next);
    }
});
onBeforeUnmount(() => { request?.abort(); });
defineExpose({ showById, focusProject });
</script>

<template>
    <section ref="root" class="conversation-history panel">
        <div class="section-heading">
            <div><h2>本地会话记录</h2><p>默认关闭。开启后聊天以明文保存在本机，请勿上传密码或密钥。</p></div>
            <div class="history-recording-control">
                <span id="history-recording-label">保存会话记录到本地</span>
                <el-switch :model-value="recordingEnabled" :disabled="busy || !recordingReady" :loading="busy || !recordingReady" aria-label="保存会话记录到本地" aria-describedby="history-recording-note" @change="emit('recordingChange', Boolean($event))" />
            </div>
        </div>
        <p id="history-recording-note" class="history-recording-note muted small" role="status">{{ !recordingReady ? "正在读取会话保存设置…" : recordingEnabled ? "已开启：保存项目使用历史、客户端发送的聊天内容和摘要检查点。" : "已关闭：停止新增保存；已有记录保留，项目绑定继续工作。" }} 重新开启不会补录关闭期间的聊天。</p>
        <el-alert v-if="unavailable" type="warning" :closable="false" :title="`${unavailable} 份记录无法读取或保存，请检查本地记录文件及权限。`" />
        <div class="conversation-history-filters">
            <el-radio-group v-model="client" aria-label="按客户端筛选">
                <el-radio-button label="全部" value="all" />
                <el-radio-button label="ChatGPT" value="chatgpt" />
                <el-radio-button label="Gemini" value="gemini" />
                <el-radio-button label="未识别" value="other" />
            </el-radio-group>
            <el-select v-model="projectId" placeholder="所有项目（含已移除）" clearable aria-label="按项目筛选" class="history-project-select">
                <el-option v-for="project in projectOptions" :key="project.id" :value="project.id" :label="`${project.name}${project.registered ? '' : '（已移除）'}`" />
            </el-select>
        </div>
        <el-table :data="visibleRecords" class="conversation-history-table" empty-text="暂无此分类的会话记录">
            <el-table-column label="客户端 / 会话" min-width="220">
                <template #default="{ row }">
                    <div class="history-session-title"><el-tag :type="row.client === 'gemini' ? 'primary' : row.client === 'chatgpt' ? 'success' : 'info'" size="small">{{ row.label }}</el-tag><strong>{{ row.title || '未命名会话' }}</strong></div>
                    <code class="muted small">{{ row.id.slice(0, 12) }}</code>
                </template>
            </el-table-column>
            <el-table-column label="使用过的项目" min-width="150"><template #default="{ row }">{{ row.projectName }}<div v-if="!row.registered" class="muted small">已移除登记</div></template></el-table-column>
            <el-table-column label="绑定状态" width="120"><template #default="{ row }"><el-tag :type="row.bound ? 'success' : 'info'" effect="plain">{{ row.bound ? '当前绑定' : '历史记录' }}</el-tag></template></el-table-column>
            <el-table-column label="最近使用" min-width="170"><template #default="{ row }">{{ formatTime(row.lastSeenAt) }}<div class="muted small">首次：{{ formatTime(row.firstSeenAt) }}</div></template></el-table-column>
            <el-table-column label="聊天 / 摘要" width="145"><template #default="{ row }"><el-button link type="primary" @click="show(row)">{{ row.messageCount ? `查看 ${row.messageCount} 条消息` : row.checkpointAt ? '查看摘要检查点' : '客户端未发送' }}</el-button><div v-if="row.checkpointAt" class="muted small">摘要：{{ formatTime(row.checkpointAt) }}</div></template></el-table-column>
            <el-table-column label="操作" width="115" fixed="right"><template #default="{ row }"><el-button text type="danger" :disabled="busy" @click="emit('delete', row)">删除记录</el-button></template></el-table-column>
        </el-table>
        <p class="muted small history-storage-note">保存目录：~/.ai-mcp/conversations/。仅保存客户端通过 MCP 实际发送的可见消息，无法自动读取整个聊天窗口。</p>

        <el-drawer v-model="open" title="已保存聊天与摘要" size="min(680px, 94vw)" class="chat-transcript-drawer">
            <template v-if="selected">
                <div class="section-heading"><div><h2>{{ selected.title || '未命名会话' }}</h2><p>{{ selected.label }} · {{ selected.projectName }} · {{ selected.bound ? '当前绑定' : '历史记录' }}</p></div></div>
                <el-alert type="info" :closable="false" title="这里显示客户端已发送的内容；未发送的聊天无法补全。一段会话可能使用过多个项目。" />
                <p v-if="transcript && transcript.projects.length > 1" class="muted small">使用过：{{ transcript.projects.map(item => item.projectName).join('、') }}</p>
                <div v-if="error" class="history-error"><el-alert type="error" :closable="false" :title="error" /><el-button :disabled="loading" @click="load(selected)">重试</el-button></div>
                <p v-if="loading" role="status">正在读取本地聊天记录…</p>
                <article v-for="checkpoint in transcript?.checkpoints" :key="checkpoint.projectId" class="chat-transcript-message">
                    <header><strong>摘要检查点 · {{ transcript?.projects.find(item => item.projectId === checkpoint.projectId)?.projectName || '历史项目' }}</strong><span class="muted small">{{ formatTime(checkpoint.savedAt) }}</span></header>
                    <div class="chat-message-content">{{ checkpoint.summary }}</div>
                    <ul><li v-for="step in checkpoint.next_steps" :key="step">{{ step }}</li></ul>
                </article>
                <el-empty v-if="!loading && !error && !transcript?.messages.length && !transcript?.checkpoints?.length" description="客户端尚未发送聊天或摘要。请让它调用 project_control(action=record / checkpoint)。" :image-size="70" />
                <div v-if="transcript" class="chat-transcript-messages">
                    <article v-for="message in transcript.messages" :key="message.id" class="chat-transcript-message" :class="`chat-role-${message.role}`">
                        <header><strong>{{ message.role === 'user' ? '你' : selected.label }}</strong><span v-if="message.timestamp" class="muted small">{{ formatTime(message.timestamp) }}</span></header>
                        <div class="chat-message-content">{{ message.content }}</div>
                    </article>
                </div>
                <template v-if="selected"><el-button type="danger" plain :disabled="busy" class="delete-chat-record-button" @click="emit('delete', selected)">删除此会话的本地记录</el-button></template>
            </template>
        </el-drawer>
    </section>
</template>
