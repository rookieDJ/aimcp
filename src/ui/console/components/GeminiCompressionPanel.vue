<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, friendlyError, type GeminiCompression } from "../api.js";

defineProps<{ busy: boolean }>();
const state = ref<GeminiCompression>();
const percent = ref(50);
const dirty = ref(false);
const saving = ref(false);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const pendingExternal = ref(false);
const savedPercent = computed(() => Math.round((state.value?.threshold ?? 0.5) * 100));
let request: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function accept(next: GeminiCompression, submitted = false): void {
    if (!dirty.value || submitted) {
        state.value = next;
        percent.value = Math.round(next.threshold * 100);
        dirty.value = false;
        pendingExternal.value = false;
    } else if (state.value?.revision !== next.revision) {
        pendingExternal.value = true;
    }
}
async function refresh(): Promise<void> {
    if (request || saving.value || document.hidden) return;
    const owner = new AbortController(); request = owner; loading.value = true;
    try {
        const result = await api<{ compression: GeminiCompression }>("/api/gemini/compression", { signal: owner.signal });
        if (!owner.signal.aborted) { accept(result.compression); error.value = ""; }
    } catch (reason) { if (!owner.signal.aborted) error.value = friendlyError(reason); }
    finally { if (request === owner) { request = undefined; loading.value = false; } }
}
async function save(reset = false): Promise<void> {
    if (!state.value || saving.value || pendingExternal.value) return;
    request?.abort();
    const owner = new AbortController(); request = owner; saving.value = true; loading.value = false;
    error.value = ""; notice.value = "";
    try {
        const result = await api<{ compression: GeminiCompression }>("/api/gemini/compression", { method: "PUT", body: { threshold: reset ? null : percent.value / 100, revision: state.value.revision }, signal: owner.signal });
        if (!owner.signal.aborted) {
            accept(result.compression, true);
            notice.value = "已更新用户级 Gemini CLI 设置。请重启 Gemini CLI；当前聊天不会被立即压缩。";
        }
    } catch (reason) { if (!owner.signal.aborted) error.value = friendlyError(reason); }
    finally { if (request === owner) { request = undefined; saving.value = false; } }
}
function reload(): void { dirty.value = false; pendingExternal.value = false; void refresh(); }
function syncVisible(): void { if (!document.hidden) void refresh(); }
onMounted(() => {
    void refresh();
    timer = setInterval(() => { void refresh(); }, 5_000);
    document.addEventListener("visibilitychange", syncVisible);
    window.addEventListener("focus", syncVisible);
});
onBeforeUnmount(() => {
    request?.abort();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", syncVisible);
    window.removeEventListener("focus", syncVisible);
});
</script>

<template>
    <section class="gemini-compression-panel">
        <div class="section-heading"><div><h2>Gemini CLI 自动压缩</h2><p>原生功能：达到阈值后，由 Gemini CLI 生成摘要并缩减聊天上下文。</p></div><el-button :disabled="saving || loading" @click="refresh">刷新设置</el-button></div>
        <el-alert type="info" :closable="false" title="仅适用于 Gemini CLI。Gemini App 没有可由 MCP 调用的公开压缩接口；摘要检查点不会清空 App 聊天上下文。" />
        <p class="muted small">写入 ~/.gemini/settings.json 的 model.compressionThreshold，保留其他配置和注释。这里显示用户级设置；项目或系统配置可能覆盖它。</p>
        <p v-if="state" role="status">用户级阈值：{{ savedPercent }}% · {{ state.source === 'default' ? '使用原生默认值' : '已在用户配置中设置' }}</p>
        <p v-else-if="loading" role="status">正在读取 Gemini CLI 设置…</p>
        <el-form label-position="top" @submit.prevent>
            <el-form-item label="触发压缩的上下文比例（10% – 90%）">
                <!-- Element Plus sets inner aria-disabled only on mount. Recreate on lock transitions. -->
                <el-input-number :key="String(busy || saving || !state)" v-model="percent" :min="10" :max="90" :step="5" :disabled="busy || saving || !state" aria-label="Gemini CLI 自动压缩阈值" @input="dirty = true; notice = ''" @change="dirty = true; notice = ''" />
            </el-form-item>
            <div class="button-row"><el-button type="primary" :loading="saving" :disabled="busy || !state || pendingExternal" @click="save(false)">保存 CLI 设置</el-button><el-button :disabled="busy || saving || !state || pendingExternal" @click="save(true)">恢复原生默认阈值</el-button></div>
        </el-form>
        <el-alert v-if="pendingExternal" type="warning" :closable="false" title="配置已被其他程序修改。你的编辑已保留，请重新读取后再保存。" />
        <el-button v-if="pendingExternal" :disabled="saving || loading" @click="reload">放弃当前编辑并重新读取</el-button>
        <el-alert v-if="error" type="error" :closable="false" :title="error" />
        <el-alert v-if="notice" type="success" :closable="false" :title="notice" />
        <p class="muted small">CLI 内可使用 /compress 手动压缩。aimcp 不会将该命令作为 shell 执行，也不会调用你的模型账户测试压缩。</p>
        <h2>Gemini App / ChatGPT 摘要检查点</h2>
        <p>在“项目 → 本地会话记录”开启保存后，客户端可调用 project_control(action=checkpoint) 保存任务摘要；重连后携带同一 project_session 调用 action=restore 恢复。</p>
        <p class="muted small">较多 MCP 调用或输出会触发保存提醒。只保存客户端实际发送的摘要；每个会话、每个项目保留最新一份，可在本地会话详情中查看并随会话删除。</p>
    </section>
</template>

<style scoped>
.gemini-compression-panel { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.gemini-compression-panel p { margin: 0; overflow-wrap: anywhere; }
.button-row { display: flex; flex-wrap: wrap; gap: 12px; }
.button-row :deep(.el-button + .el-button) { margin-left: 0; }
</style>
