<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
    Connection, Expand, Fold, FolderOpened, HomeFilled, InfoFilled, MagicStick, Refresh, Search, Setting, SwitchButton, Tools, VideoPause, VideoPlay,
} from "@element-plus/icons-vue";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { ElMessage } from "element-plus/es/components/message/index";
import { ElMessageBox } from "element-plus/es/components/message-box/index";
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
import {
    api, consoleVersion, followOperation, friendlyError,
    type CapabilityConfig, type ConnectionCheck, type ConsoleSnapshot, type ControllerStatus, type Conversation,
    type OperationSnapshot, type Project, type SetupSummary, type ConversationRecord,
} from "./api.js";
import AddProjectDialog from "./components/AddProjectDialog.vue";
import HomeView from "./views/HomeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ConnectView from "./views/ConnectView.vue";
import MaintenanceView from "./views/MaintenanceView.vue";
import ParticlesBackground from "./components/ParticlesBackground.vue";

type Page = "home" | "projects" | "connect" | "maintenance";
type OperationScope = "connect" | "maintenance";

const navigation = [
    { id: "home" as const, label: "概览", icon: HomeFilled, badge: "01" },
    { id: "projects" as const, label: "项目", icon: FolderOpened, badge: "02" },
    { id: "connect" as const, label: "连接", icon: Connection, badge: "03" },
    { id: "maintenance" as const, label: "系统", icon: Tools, badge: "04" },
];

const page = ref<Page>("home");
const sidebarCollapsed = ref(false);
const navigationQuery = ref("");
const particlesEnabled = ref(true);
try { particlesEnabled.value = localStorage.getItem("aimcp.console.particles") !== "off"; } catch { /* Storage is optional for this visual preference. */ }
function toggleParticles(): void {
    particlesEnabled.value = !particlesEnabled.value;
    try { localStorage.setItem("aimcp.console.particles", particlesEnabled.value ? "on" : "off"); } catch { /* Keep the in-memory preference. */ }
}
const filteredNavigation = computed(() => navigation.filter(item => item.label.includes(navigationQuery.value.trim())));
const addOpen = ref(false);
const detailsOpen = ref(false);
const controllerClosed = ref(false);
const status = ref<ControllerStatus>();
const projects = ref<Project[]>([]);
const conversations = ref<Conversation[]>([]);
const conversationRecords = ref<ConversationRecord[]>([]);
const unavailableConversationRecords = ref(0);
const setup = ref<SetupSummary>();
const connectionResult = ref<ConnectionCheck>();
const loading = ref(true);
const refreshing = ref(false);
const busyOwners = ref(0);
const loadError = ref("");
const syncError = ref("");
const zones = ref<string[]>([]);
const operations = ref<Partial<Record<OperationScope, OperationSnapshot>>>({});
const operationCleanups = new Map<string, { close: () => void; release: () => void }>();
let pollTimer: number | undefined;
let liveRefresh: Promise<void> | undefined;
const LIVE_SYNC_MS = 2_000;

const busy = computed(() => busyOwners.value > 0 || refreshing.value);
const running = computed(() => status.value?.runtime.running === true);
const pageTitle = computed(() => navigation.find((item) => item.id === page.value)?.label ?? "概览");
const liveRuntime = computed(() => status.value?.runtime.runtime);
const checkContext = computed(() => JSON.stringify([
    status.value?.runtime.running,
    status.value?.runtime.runtime?.pid,
    setup.value?.config.publicAccess,
    setup.value?.passwordConfigured,
    projects.value.map((project) => [project.id, project.active]),
]));
watch(checkContext, () => { connectionResult.value = undefined; });

function applySnapshot(snapshot: ConsoleSnapshot): void {
    status.value = snapshot.status;
    projects.value = snapshot.status.runtime.projects ?? [];
    conversations.value = snapshot.conversations;
    conversationRecords.value = snapshot.conversationRecords ?? [];
    unavailableConversationRecords.value = snapshot.unavailableConversationRecords ?? 0;
    if (setup.value) {
        setup.value = {
            ...setup.value,
            config: snapshot.setup.config,
            passwordConfigured: snapshot.setup.passwordConfigured,
        };
    }
}

async function refreshLive(showError = false): Promise<void> {
    if (controllerClosed.value) return;
    if (liveRefresh) return await liveRefresh;
    liveRefresh = (async () => {
        try {
            applySnapshot(await api<ConsoleSnapshot>("/api/console/snapshot"));
            syncError.value = "";
            if (showError) loadError.value = "";
        } catch (error) {
            syncError.value = friendlyError(error);
            if (showError) loadError.value = syncError.value;
        }
    })();
    try { await liveRefresh; }
    finally { liveRefresh = undefined; }
}

async function refreshAll(showError = true): Promise<void> {
    refreshing.value = true;
    try {
        if (liveRefresh) await liveRefresh;
        const results = await Promise.allSettled([
            api<ConsoleSnapshot>("/api/console/snapshot"),
            api<SetupSummary>("/api/setup/summary"),
        ]);
        if (results[0].status === "fulfilled") { applySnapshot(results[0].value); syncError.value = ""; }
        if (results[1].status === "fulfilled") setup.value = results[1].value;
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed && showError) loadError.value = friendlyError(failed.reason);
        else if (!failed) loadError.value = "";
    } finally {
        refreshing.value = false;
        loading.value = false;
    }
}

function syncPageFromLocation(): void {
    const requested = window.location.hash.replace(/^#/, "");
    const match = navigation.find((item) => item.id === requested || (requested === "system" && item.id === "maintenance"));
    if (match) page.value = match.id;
}
function refreshWhenVisible(): void {
    if (document.visibilityState === "visible") void refreshLive(false);
}

onMounted(() => {
    syncPageFromLocation();
    void refreshAll();
    pollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible" && !refreshing.value) void refreshLive(false);
    }, LIVE_SYNC_MS);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("popstate", syncPageFromLocation);
    window.addEventListener("hashchange", syncPageFromLocation);
    document.addEventListener("visibilitychange", refreshWhenVisible);
});
onBeforeUnmount(() => {
    if (pollTimer !== undefined) window.clearInterval(pollTimer);
    window.removeEventListener("focus", refreshWhenVisible);
    window.removeEventListener("popstate", syncPageFromLocation);
    window.removeEventListener("hashchange", syncPageFromLocation);
    document.removeEventListener("visibilitychange", refreshWhenVisible);
    for (const owner of operationCleanups.values()) { owner.close(); owner.release(); }
    operationCleanups.clear();
});

function claimBusy(): () => void {
    busyOwners.value += 1;
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        busyOwners.value = Math.max(0, busyOwners.value - 1);
    };
}

async function runAction(action: () => Promise<void>, successMessage?: string): Promise<boolean> {
    const release = claimBusy();
    try {
        await action();
        if (successMessage) ElMessage.success(successMessage);
        return true;
    } catch (error) {
        ElMessage.error(friendlyError(error));
        return false;
    } finally {
        release();
    }
}

async function startOperation(
    scope: OperationScope,
    path: string,
    body: unknown,
    successMessage: string,
    onDone?: (result: unknown) => void | Promise<void>,
): Promise<void> {
    const release = claimBusy();
    try {
        const response = await api<{ operation: OperationSnapshot }>(path, { method: "POST", body });
        const finish = async (snapshot: OperationSnapshot): Promise<void> => {
            const owner = operationCleanups.get(snapshot.id);
            try {
                if (snapshot.state === "succeeded") {
                    await onDone?.(snapshot.result);
                    ElMessage.success(successMessage);
                } else if (snapshot.state === "failed") {
                    ElMessage.error(friendlyError(snapshot.error ?? "操作未完成"));
                }
            } catch (error) {
                ElMessage.error(friendlyError(error));
            } finally {
                owner?.release();
                operationCleanups.delete(snapshot.id);
            }
        };
        const close = followOperation(response.operation, (snapshot) => {
            operations.value = { ...operations.value, [scope]: snapshot };
        }, (snapshot) => { void finish(snapshot); });
        operationCleanups.set(response.operation.id, { close, release });
    } catch (error) {
        release();
        ElMessage.error(friendlyError(error));
    }
}

async function confirmAction(title: string, description: string, confirmLabel: string, action: () => unknown | Promise<unknown>, danger = false): Promise<void> {
    try {
        await ElMessageBox.confirm(description, title, {
            confirmButtonText: confirmLabel,
            cancelButtonText: "取消",
            type: danger ? "warning" : "info",
            distinguishCancelAndClose: true,
        });
        await action();
    } catch (error) {
        if (error === "cancel" || error === "close") return;
        throw error;
    }
}

function navigate(next: Page): void {
    page.value = next;
    const hash = next === "maintenance" ? "system" : next;
    if (window.location.hash !== `#${hash}`) window.history.pushState(null, "", `#${hash}`);
}
function handleMenuSelect(value: string): void { navigate(value as Page); }

function startRuntime(mode: "local" | "public"): void {
    void runAction(async () => {
        connectionResult.value = undefined;
        await api("/api/runtime/start", {
            method: "POST",
            body: mode === "local"
                ? { local: true, noTunnel: true, tunnelLogs: false, intentSpecified: true }
                : { local: false, noTunnel: false, tunnelLogs: false, intentSpecified: true },
        });
        await refreshLive(false);
    }, mode === "local" ? "MCP 已以本机模式启动" : "MCP 已以公网模式启动");
}
function restartRuntime(): void {
    void runAction(async () => {
        connectionResult.value = undefined;
        await api("/api/runtime/restart", { method: "POST", body: {} });
        await refreshLive(false);
    }, "MCP 服务已重新启动");
}
function stopRuntime(): void {
    void confirmAction("停止 MCP 服务？", "连接到 aimcp 的客户端将暂时无法使用项目。控制面板会继续运行。", "停止服务", () => runAction(async () => {
        connectionResult.value = undefined;
        await api("/api/runtime/stop", { method: "POST", body: {} });
        await refreshLive(false);
    }, "MCP 服务已停止"), true);
}
function shutdownAll(): void {
    void confirmAction("完全关闭 aimcp？", "MCP Runtime、Tunnel 和 Web Console 都会退出。项目和连接配置会保留。", "完全关闭", () => runAction(async () => {
        await api("/api/controller/shutdown", { method: "POST", body: {} });
        if (pollTimer !== undefined) window.clearInterval(pollTimer);
        pollTimer = undefined;
        detailsOpen.value = false;
        controllerClosed.value = true;
    }, "aimcp 已关闭"), true);
}
async function addProject(path: string): Promise<boolean> {
    return await runAction(async () => {
        await api("/api/projects", { method: "POST", body: { path } });
        connectionResult.value = undefined;
        await refreshLive(false);
    }, "项目已添加");
}
function reactivateProject(project: Project): void {
    void runAction(async () => {
        await api("/api/projects", { method: "POST", body: { path: project.path } });
        connectionResult.value = undefined;
        await refreshLive(false);
    }, "项目已重新启用");
}
function deactivateProject(project: Project): void {
    void confirmAction(`停用“${project.name}”？`, "保留项目登记，之后可直接重新启用。客户端将不能使用此项目，现有绑定和该项目运行资源会清除；本地文件与已保存聊天历史保留。", "停用项目", () => runAction(async () => {
        await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE", body: {} });
        await refreshLive(false);
    }, "项目已停用"), true);
}
function removeProject(project: Project): void {
    void confirmAction(`移除“${project.name}”的登记？`, "将从已登记项目列表移除，清除其会话绑定并停止该项目的运行资源。本地文件保留，已保存聊天历史也保留。其他项目和 MCP 服务继续运行；以后需重新添加此目录。", "移除登记", () => runAction(async () => {
        await api(`/api/projects/${encodeURIComponent(project.id)}?forget=true`, { method: "DELETE", body: {} });
        connectionResult.value = undefined;
        if (liveRefresh) await liveRefresh;
        await refreshLive(false);
    }, "项目登记已移除"), true);
}
function cleanupConversations(project: Project, conversationIds: string[]): void {
    if (!conversationIds.length) return;
    void confirmAction("清除会话绑定？", `将解除 ${conversationIds.length} 个会话当前的项目绑定。项目使用历史、已保存聊天内容和本地文件都会保留。`, "清除绑定", () => runAction(async () => {
        await api(`/api/projects/${encodeURIComponent(project.id)}/conversations/cleanup`, { method: "POST", body: { conversationIds } });
        await refreshLive(false);
    }, "会话绑定已清理"), true);
}
function deleteConversationRecord(record: ConversationRecord): void {
    void confirmAction(`删除“${record.title || record.label + ' 会话'}”的本地记录？`, "将永久删除此会话已保存的聊天内容、摘要检查点及它在所有项目中的使用历史，无法恢复。当前项目绑定、项目文件和 GPT/Gemini 客户端聊天保留。客户端之后再次发送聊天内容或重新选择项目时，会生成新的记录。", "删除本地记录", () => runAction(async () => {
        await api(`/api/conversations/${encodeURIComponent(record.id)}`, { method: "DELETE" });
        if (liveRefresh) await liveRefresh;
        await refreshLive(false);
    }, "本地会话记录已删除"), true);
}
function discoverCloudflare(): void {
    void startOperation("connect", "/api/setup/cloudflare/discover", { forceLogin: false }, "已读取可用域名", (result) => {
        zones.value = (result as { zones?: string[] } | undefined)?.zones ?? [];
    });
}
function applyCloudflare(zone: string, prefix: string, overwrite: boolean): void {
    const action = () => startOperation("connect", "/api/setup/public/cloudflare", { zone, prefix, allowDnsOverwrite: overwrite }, "公网 MCP 地址已配置", () => refreshLive(false));
    if (!overwrite) { void action(); return; }
    void confirmAction("允许替换同名 DNS 记录？", `如果 ${prefix}.${zone} 已被其他服务使用，原记录会被替换。`, "允许并继续", action, true);
}
function applyExternal(domain: string): void {
    void startOperation("connect", "/api/setup/public/external", { domain }, "自有域名已保存并通过检查", () => refreshLive(false));
}
function checkPublicAccess(): void {
    void runAction(async () => {
        connectionResult.value = undefined;
        connectionResult.value = await api<ConnectionCheck>("/api/connection-check", { method: "POST", body: {} });
    });
}
async function savePassword(password: string): Promise<void> {
    await runAction(async () => {
        await api("/api/auth/password", { method: "POST", body: { password } });
        await refreshLive(false);
    }, "连接密码已保存");
}
async function generatePassword(): Promise<string | undefined> {
    let password: string | undefined;
    await runAction(async () => {
        password = (await api<{ password: string }>("/api/auth/generate", { method: "POST", body: {} })).password;
        await refreshLive(false);
    }, "安全密码已生成并设置");
    return password;
}
async function setConversationRecording(enabled: boolean): Promise<void> {
    await runAction(async () => {
        const result = await api<{ enabled: boolean }>("/api/conversations/recording", { method: "PUT", body: { enabled } });
        if (liveRefresh) await liveRefresh;
        if (setup.value) setup.value = { ...setup.value, config: { ...setup.value.config, saveConversations: result.enabled } };
        await refreshLive(false);
    }, enabled ? "已开启本地会话保存" : "已关闭本地会话保存，已有记录保留");
}
async function saveCapabilities(config: CapabilityConfig): Promise<void> {
    await runAction(async () => {
        const sources = { ...config.sources, agents: { ...config.sources.agents, mcp: false } };
        await api("/api/setup/capabilities", { method: "POST", body: { config: { ...config, priority: ["agents", "codex", "gemini", "claude"], sources } } });
        await refreshAll(false);
    }, "工具设置已保存");
}
function runDoctor(fix: boolean): void {
    const action = () => startOperation("maintenance", "/api/doctor", { fix }, fix ? "检查和修复已完成" : "服务检查已完成");
    if (!fix) { void action(); return; }
    void confirmAction("检查并修复常见问题？", "恢复缺失组件、创建缺失目录、清理失效状态，并重连中断的本机托管隧道。MCP 服务与项目会话保留，Cloudflare DNS 和连接配置保持不变。", "开始修复", action);
}
function selfUpdate(): void {
    void confirmAction("检查并安装最新版本？", "更新期间 MCP 服务和控制面板会短暂重启，项目与连接设置会保留。", "检查并更新", () => startOperation("maintenance", "/api/update", {}, "新版本已安装", (result) => {
        const reloadUrl = (result as { reloadUrl?: string } | undefined)?.reloadUrl;
        if (reloadUrl) window.setTimeout(() => { window.location.href = reloadUrl; }, 800);
    }));
}
function cancelOperation(id: string): void {
    void runAction(async () => { await api(`/api/operations/${encodeURIComponent(id)}`, { method: "DELETE", body: {} }); }, "已请求取消操作");
}
function handleResultAction(action: "start" | "connect" | "projects" | "repair"): void {
    if (action === "start") startRuntime(setup.value?.config.publicAccess && setup.value.passwordConfigured ? "public" : "local");
    else if (action === "projects") addOpen.value = true;
    else if (action === "repair") { navigate("maintenance"); runDoctor(true); }
    else navigate("connect");
}
</script>

<template>
    <el-config-provider :locale="zhCn">
    <div v-if="controllerClosed" class="console-closed">
        <div class="console-closed-card">
            <div class="console-logo">A</div>
            <h1>aimcp 已关闭</h1>
            <p>Runtime 和 Web Console 都已退出，项目与连接配置仍然保留。</p>
            <div class="terminal-pill"><code>aimcp open</code></div>
            <div class="muted small">需要重新管理时，在终端运行上面的命令。</div>
        </div>
    </div>
    <div v-else class="console-shell" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
        <ParticlesBackground v-if="particlesEnabled" />
        <header class="console-topbar">
            <div class="console-brand">
                <span class="console-brand-text">aimcp<span class="brand-period">.</span></span>
                <span class="topbar-slash">/</span>
                <span class="console-brand-caption">本机控制台</span>
            </div>
            <el-select :model-value="page" class="console-mobile-nav" aria-label="页面导航" @change="handleMenuSelect">
                <el-option v-for="item in navigation" :key="item.id" :label="item.label" :value="item.id" />
            </el-select>
            <div class="topbar-actions">
                <el-tooltip :content="particlesEnabled ? '关闭粒子效果' : '开启粒子效果'" placement="bottom">
                    <el-button class="topbar-icon-btn particle-toggle" :class="{ 'is-active': particlesEnabled }" :icon="MagicStick" aria-label="粒子效果" :aria-pressed="particlesEnabled" @click="toggleParticles" />
                </el-tooltip>
                <div class="runtime-status-pill" :class="{ 'is-running': running && !loading, 'is-loading': loading }">
                    <span class="status-pulse-dot"></span>
                    <span class="status-pill-text">{{ loading ? "正在连接" : running ? "服务运行中" : "服务未启动" }}</span>
                </div>
                <el-tooltip content="刷新状态" placement="bottom">
                    <el-button class="topbar-icon-btn" :icon="Refresh" :loading="refreshing" aria-label="刷新" @click="refreshAll()" />
                </el-tooltip>
                <el-tooltip content="运行详情与控制" placement="bottom">
                    <el-button class="topbar-icon-btn" :icon="InfoFilled" aria-label="技术详情" @click="detailsOpen = true" />
                </el-tooltip>
            </div>
        </header>
        <aside class="console-sidebar">
            <div class="sidebar-category-tabs" aria-label="快捷页面">
                <el-tooltip v-for="item in navigation" :key="item.id" :content="item.label" placement="bottom">
                    <el-button text :class="{ 'is-selected': page === item.id }" :aria-label="`打开${item.label}`" :aria-current="page === item.id ? 'page' : undefined" @click="navigate(item.id)">
                        <el-icon><component :is="item.icon" /></el-icon>
                    </el-button>
                </el-tooltip>
            </div>
            <el-input v-if="!sidebarCollapsed" v-model="navigationQuery" class="navigation-filter" :prefix-icon="Search" placeholder="筛选页面…" aria-label="筛选页面" clearable />
            <div v-if="!sidebarCollapsed" class="console-nav-caption">工作空间</div>
            <el-menu class="console-menu" :default-active="page" :collapse="sidebarCollapsed" :collapse-transition="false" @select="handleMenuSelect">
                <el-menu-item v-for="item in filteredNavigation" :key="item.id" :index="item.id">
                    <el-icon><component :is="item.icon" /></el-icon>
                    <template #title><span class="menu-label-text">{{ item.label }}</span></template>
                </el-menu-item>
            </el-menu>
            <p v-if="!sidebarCollapsed && !filteredNavigation.length" class="navigation-empty muted small">没有匹配的页面</p>
            <div v-if="!sidebarCollapsed" class="sidebar-context">
                <span class="console-nav-caption">当前工作空间</span>
                <div><span>可用项目</span><strong>{{ projects.filter(item => item.active).length }}</strong></div>
                <div><span>会话绑定</span><strong>{{ conversations.length }}</strong></div>
                <div><span>本地记录</span><strong>{{ conversationRecords.length }}</strong></div>
            </div>
            <div class="console-sidebar-footer">
                <div v-if="!sidebarCollapsed" class="sidebar-health"><span class="sidebar-health-light"></span><span>本机控制面在线</span></div>
                <el-tooltip :content="sidebarCollapsed ? '展开导航' : '收起导航'" placement="right">
                    <el-button text class="console-collapse" :aria-label="sidebarCollapsed ? '展开导航' : '收起导航'" @click="sidebarCollapsed = !sidebarCollapsed">
                        <el-icon size="16"><Expand v-if="sidebarCollapsed" /><Fold v-else /></el-icon>
                        <span v-if="!sidebarCollapsed">收起导航</span>
                    </el-button>
                </el-tooltip>
                <div v-if="!sidebarCollapsed" class="console-version">v{{ consoleVersion }} · 仅本机访问</div>
            </div>
        </aside>
        <main class="console-main" :aria-label="pageTitle">
            <div class="console-content" :class="`page-${page}`">
                <el-alert
                    v-if="loadError || syncError"
                    type="error"
                    :closable="false"
                    :title="loadError || syncError"
                    class="console-alert-banner"
                />

                <HomeView
                    v-if="page === 'home'"
                    :status="status"
                    :setup="setup"
                    :projects="projects"
                    :conversation-count="conversations.length"
                    :loading="loading"
                    :busy="busy"
                    :result="connectionResult"
                    @navigate="navigate"
                    @add="addOpen = true"
                    @start="startRuntime"
                    @stop="stopRuntime"
                    @check="checkPublicAccess"
                    @repair="navigate('maintenance'); runDoctor(true)"
                />

                <ProjectsView
                    v-else-if="page === 'projects'"
                    :projects="projects"
                    :conversations="conversations"
                    :records="conversationRecords"
                    :unavailable-records="unavailableConversationRecords"
                    :recording-enabled="setup?.config.saveConversations ?? false"
                    :recording-ready="Boolean(setup)"
                    :busy="busy"
                    @recording-change="setConversationRecording"
                    @add="addOpen = true"
                    @reactivate="reactivateProject"
                    @remove="removeProject"
                    @deactivate="deactivateProject"
                    @cleanup="cleanupConversations"
                    @delete-record="deleteConversationRecord"
                    @renamed="refreshAll()"
                />

                <ConnectView
                    v-else-if="page === 'connect'"
                    :setup="setup"
                    :result="connectionResult"
                    :operation="operations.connect"
                    :zones="zones"
                    :busy="busy"
                    :save-password="savePassword"
                    :generate-password="generatePassword"
                    @check="checkPublicAccess"
                    @discover="discoverCloudflare"
                    @apply-cloudflare="applyCloudflare"
                    @apply-external="applyExternal"
                    @cancel-operation="cancelOperation"
                    @result-action="handleResultAction"
                />

                <MaintenanceView
                    v-else
                    :setup="setup"
                    :operation="operations.maintenance"
                    :busy="busy"
                    :save-capabilities="saveCapabilities"
                    @doctor="runDoctor"
                    @update="selfUpdate"
                    @cancel-operation="cancelOperation"
                />
            </div>
        </main>

        <AddProjectDialog v-model="addOpen" :busy="busy" :add-project="addProject" />

        <el-drawer
            v-model="detailsOpen"
            class="technical-details-drawer"
            title="运行详情与控制"
            size="min(480px, 92vw)"
        >
            <div class="inline-actions technical-action-bar">
                <el-button :icon="Setting" @click="detailsOpen = false; navigate('maintenance')">系统设置</el-button>
                <el-button :icon="VideoPlay" :disabled="busy || !running" @click="restartRuntime">重启 Runtime</el-button>
                <el-button type="danger" plain :icon="VideoPause" :disabled="busy || !running" @click="stopRuntime">停止 Runtime</el-button>
                <el-button type="danger" text :icon="SwitchButton" :disabled="busy" @click="shutdownAll">完全关闭</el-button>
            </div>

            <div class="technical-meta-card">
                <div class="meta-row">
                    <span class="meta-label">Controller</span>
                    <span class="meta-val"><span class="badge-dot is-online"></span>运行中 (PID {{ status?.pid ?? "—" }})</span>
                </div>
                <div class="meta-row">
                    <span class="meta-label">MCP Runtime</span>
                    <span class="meta-val">{{ running ? `运行中 (PID ${liveRuntime?.pid ?? "—"})` : "未启动" }}</span>
                </div>
                <div class="meta-row">
                    <span class="meta-label">运行模式</span>
                    <span class="meta-val mono">{{ liveRuntime?.mode === "local" ? "仅本机 (Local)" : liveRuntime?.mode ?? "—" }}</span>
                </div>
                <div class="meta-row">
                    <span class="meta-label">公网连接</span>
                    <span class="meta-val">{{ liveRuntime?.publicMcpUrl ? "已建立隧道" : "未连接" }}</span>
                </div>
                <div class="meta-row">
                    <span class="meta-label">鉴权状态</span>
                    <span class="meta-val">{{ liveRuntime?.auth?.required ? (liveRuntime.auth.configured ? "已保护 (OAuth/Password)" : "等待设置密码") : "本机模式 (无须密码)" }}</span>
                </div>
                <div class="meta-row meta-row-endpoint">
                    <span class="meta-label">本机 MCP 地址</span>
                    <code class="meta-code break-all">{{ liveRuntime?.localUrl ?? "—" }}</code>
                </div>
                <div class="meta-row meta-row-endpoint">
                    <span class="meta-label">公网 MCP 地址</span>
                    <code class="meta-code break-all">{{ liveRuntime?.publicMcpUrl ?? (setup?.config.publicAccess ? `https://${setup.config.publicAccess.domain}/mcp` : "—") }}</code>
                </div>
            </div>

            <div class="section-heading" style="margin-top: 24px">
                <div>
                    <h2>常用控制命令</h2>
                    <p>在终端中可随时操作后台实例</p>
                </div>
            </div>
            <div class="command-list">
                <div class="command-row"><code>aimcp status</code><span class="muted small">查看运行状态</span></div>
                <div class="command-row"><code>aimcp start</code><span class="muted small">按保存偏好启动</span></div>
                <div class="command-row"><code>aimcp logs -f</code><span class="muted small">实时跟随日志</span></div>
                <div class="command-row"><code>aimcp doctor</code><span class="muted small">全面诊断与排查</span></div>
            </div>
        </el-drawer>
    </div>
    </el-config-provider>
</template>
