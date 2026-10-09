<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Download, Refresh, Tools } from "@element-plus/icons-vue";
import { api, friendlyError, type CapabilityConfig, type OperationSnapshot, type SetupSummary } from "../api.js";
import CapabilitiesPanel from "../components/CapabilitiesPanel.vue";
import OperationPanel from "../components/OperationPanel.vue";
import SpotlightCard from "../components/SpotlightCard.vue";

interface DoctorResult {
    fixes?: string[];
    warnings?: string[];
    report?: { checkedAt?: string; errors?: number; warnings?: number; checks?: Array<{ level: "ok" | "warn" | "error"; label: string; detail: string; hint?: string }> };
}

const props = defineProps<{
    setup?: SetupSummary;
    operation?: OperationSnapshot;
    busy: boolean;
    saveCapabilities: (config: CapabilityConfig) => Promise<void>;
}>();
const emit = defineEmits<{ doctor: [fix: boolean]; update: []; cancelOperation: [id: string] }>();
const tab = ref("check");
const lines = ref(100);
const logs = ref("尚未读取日志。\n");
const logError = ref("");
let logSource: EventSource | undefined;

const doctor = computed(() => props.operation?.kind.startsWith("doctor") && props.operation.result ? props.operation.result as DoctorResult : undefined);
const checkFilter = ref("all");
const orderedChecks = computed(() => {
    const priority = { error: 0, warn: 1, ok: 2 };
    return [...(doctor.value?.report?.checks ?? [])].filter(check => checkFilter.value !== "issues" || check.level !== "ok").sort((a, b) => priority[a.level] - priority[b.level]);
});
const checkedAt = computed(() => doctor.value?.report?.checkedAt ? new Date(doctor.value.report.checkedAt).toLocaleTimeString("zh-CN") : "");

async function readLogs(): Promise<void> {
    try {
        lines.value = Math.max(1, Math.min(5000, Math.trunc(lines.value || 100)));
        const result = await api<{ text: string }>(`/api/logs?lines=${lines.value}`);
        logs.value = result.text || "当前没有运行日志。\n";
        logError.value = "";
    } catch (error) {
        logError.value = friendlyError(error);
    }
}
function stopLogStream(): void { logSource?.close(); logSource = undefined; }
function startLogStream(): void {
    stopLogStream();
    void readLogs();
    logSource = new EventSource(`/api/logs/stream?lines=${lines.value}`);
    logSource.onopen = () => { logError.value = ""; };
    logSource.onerror = () => { logError.value = "实时日志连接暂时中断，正在自动重连。"; };
    logSource.addEventListener("logs", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { text?: string };
        logs.value = data.text || "当前没有运行日志。\n";
    });
}
watch(tab, (value) => value === "logs" ? startLogStream() : stopLogStream());
onBeforeUnmount(stopLogStream);

function friendlyCheck(label: string, detail: string, level: "ok" | "warn" | "error"): { title: string; detail: string } {
    const titles: Record<string, string> = {
        "Node.js": "运行环境", "Git": "Git 工具", "文件搜索": "文件搜索 (ripgrep)", "配置文件": "本机设置",
        "外部能力": "可用工具与技能", "连接密码": "连接密码", "公网地址": "公网 MCP 地址", "守护进程": "MCP 服务",
    };
    if (label === "守护进程" && /^pid\s/i.test(detail)) return { title: titles[label]!, detail: "服务正在本机运行。" };
    if (label === "配置文件" && level === "ok") return { title: titles[label]!, detail: "设置文件可以正常读取。" };
    return { title: titles[label] ?? label, detail };
}
function tagType(level: "ok" | "warn" | "error"): "success" | "warning" | "danger" {
    return level === "ok" ? "success" : level === "warn" ? "warning" : "danger";
}
</script>

<template>
    <div class="maintenance-view">
        <div class="page-heading maintenance-heading">
            <div class="page-heading-copy">
                <h1 class="page-title">系统</h1>
                <p>全面体检运行依赖、按需同步外部工具源、实时监控日志流，并一键升级。</p>
            </div>
            <div class="maintenance-heading-note">
                <span class="maintenance-note-mark">SYS</span>
                <span>本机维护中心</span>
            </div>
        </div>

        <SpotlightCard class="maintenance-bento-card">
            <div class="maintenance-card-inner">
                <el-tabs v-model="tab" class="maintenance-tabs modern-pill-tabs">
                    <!-- Tab 1: Check & Repair -->
                    <el-tab-pane label="健康诊断与修复" name="check">
                        <div class="tab-pane-content">
                            <div class="section-heading">
                                <div>
                                    <h2>环境与依赖深度诊断 (Doctor)</h2>
                                    <p>检查依赖、项目、会话、MCP 与公网入口；自动修复可恢复组件和重连本机隧道，保留连接配置。</p>
                                </div>
                                <div class="inline-actions">
                                    <el-button :disabled="busy" @click="emit('doctor', false)">
                                        仅运行检查
                                    </el-button>
                                    <el-button type="primary" :icon="Tools" :disabled="busy" @click="emit('doctor', true)">
                                        诊断并自动修复
                                    </el-button>
                                </div>
                            </div>

                            <OperationPanel v-if="operation?.kind.startsWith('doctor')" :operation="operation" @cancel="emit('cancelOperation', $event)" />

                            <div v-if="doctor?.report" class="inline-actions doctor-summary">
                                <el-tag :type="doctor.report.errors ? 'danger' : 'success'">{{ doctor.report.errors ?? 0 }} 个错误</el-tag>
                                <el-tag type="warning">{{ doctor.report.warnings ?? 0 }} 个提示</el-tag>
                                <span class="muted small">{{ checkedAt ? `检查于 ${checkedAt}` : '' }}</span>
                                <el-radio-group v-model="checkFilter" size="small" aria-label="诊断结果筛选">
                                    <el-radio-button value="all">全部检查</el-radio-button>
                                    <el-radio-button value="issues">只看问题</el-radio-button>
                                </el-radio-group>
                            </div>

                            <div v-if="doctor?.fixes?.length || doctor?.warnings?.length || doctor?.report?.checks?.length" class="doctor-results-grid">
                                <div v-for="fix in doctor?.fixes" :key="fix" class="doctor-result-row is-fix">
                                    <div class="result-text-area">
                                        <div class="result-title">已完成自动修复</div>
                                        <div class="result-detail muted small">{{ fix }}</div>
                                    </div>
                                    <el-tag type="success" effect="light" class="result-tag">已修复</el-tag>
                                </div>

                                <div v-for="warning in doctor?.warnings" :key="warning" class="doctor-result-row is-warning">
                                    <div class="result-text-area">
                                        <div class="result-title">自动修复未完全覆盖</div>
                                        <div class="result-detail muted small">{{ warning }}</div>
                                    </div>
                                    <el-tag type="warning" effect="light" class="result-tag">需注意</el-tag>
                                </div>

                                <div v-for="check in orderedChecks" :key="`${check.label}-${check.detail}`" class="doctor-result-row">
                                    <div class="result-text-area">
                                        <div class="result-title">{{ friendlyCheck(check.label, check.detail, check.level).title }}</div>
                                        <div class="result-detail muted small">{{ friendlyCheck(check.label, check.detail, check.level).detail }}</div>
                                        <div v-if="check.hint" class="result-detail small">建议：{{ check.hint }}</div>
                                    </div>
                                    <el-tag :type="tagType(check.level)" effect="light" class="result-tag">
                                        {{ check.level === 'ok' ? '正常通过' : check.level === 'warn' ? '需要关注' : '亟待处理' }}
                                    </el-tag>
                                </div>
                                <el-empty v-if="checkFilter === 'issues' && !orderedChecks.length" description="没有需要处理的检查结果" :image-size="64" />
                            </div>
                            <div v-else-if="!operation?.kind.startsWith('doctor')" class="doctor-idle-placeholder">
                                <div class="idle-icon-wrap">✓</div>
                                <div class="idle-text">点击上方“仅运行检查”或“诊断并自动修复”对本机环境进行全面体检</div>
                            </div>
                        </div>
                    </el-tab-pane>

                    <!-- Tab 2: External Capabilities -->
                    <el-tab-pane label="外部工具与技能" name="capabilities">
                        <div class="tab-pane-content">
                            <CapabilitiesPanel class="maintenance-capabilities" :setup="setup" :busy="busy" :save-capabilities="saveCapabilities" />
                        </div>
                    </el-tab-pane>

                    <!-- Tab 3: Realtime Logs Terminal -->
                    <el-tab-pane label="运行日志终端" name="logs">
                        <div class="tab-pane-content">
                            <div class="section-heading">
                                <div>
                                    <h2>实时运行日志 (Runtime Logs)</h2>
                                    <p>监控后台 MCP 服务、工具执行、公网隧道与连接事件。</p>
                                </div>
                                <div class="inline-actions">
                                    <span class="muted small">提取行数：</span>
                                    <el-input-number v-model="lines" :min="1" :max="5000" :controls="false" style="width: 80px" />
                                    <el-button :icon="Refresh" @click="startLogStream">重新加载</el-button>
                                </div>
                            </div>

                            <el-alert v-if="logError" type="error" :closable="false" :title="logError" style="margin-bottom: 12px" />

                            <div class="console-terminal-card">
                                <div class="terminal-titlebar">
                                    <div class="mac-buttons">
                                        <span class="mac-dot mac-dot--red"></span>
                                        <span class="mac-dot mac-dot--yellow"></span>
                                        <span class="mac-dot mac-dot--green"></span>
                                    </div>
                                    <span class="terminal-filename">aimcp-daemon.log</span>
                                    <div class="terminal-status">
                                        <span class="pulse-dot"></span>
                                        <span class="status-stream-text">实时连接 · {{ lines }} 行</span>
                                    </div>
                                </div>
                                <pre class="terminal-pre">{{ logs }}</pre>
                            </div>
                        </div>
                    </el-tab-pane>

                    <!-- Tab 4: Software Update -->
                    <el-tab-pane label="版本更新" name="update">
                        <div class="tab-pane-content">
                            <div class="section-heading">
                                <div>
                                    <h2>版本管理与检查更新</h2>
                                    <p>检查 npm 上发布的最新稳定版本并平滑升级。更新会短暂重启服务，项目与连接配置完整保留。</p>
                                </div>
                                <el-button type="primary" :icon="Download" :disabled="busy" @click="emit('update')">
                                    检查并安装最新版本
                                </el-button>
                            </div>
                            <OperationPanel v-if="operation?.kind === 'update'" :operation="operation" @cancel="emit('cancelOperation', $event)" />
                        </div>
                    </el-tab-pane>
                </el-tabs>
            </div>
        </SpotlightCard>
    </div>
</template>
