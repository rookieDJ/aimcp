<script setup lang="ts">
import { computed } from "vue";
import { CopyDocument, FolderAdd, Link, VideoPause, VideoPlay, Refresh, Tools } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus/es/components/message/index";
import "element-plus/es/components/message/style/css";
import type { ConnectionCheck, ControllerStatus, Project, SetupSummary } from "../api.js";
import ConnectionResult from "../components/ConnectionResult.vue";

const props = defineProps<{
    status?: ControllerStatus;
    setup?: SetupSummary;
    projects: Project[];
    conversationCount: number;
    loading: boolean;
    busy: boolean;
    result?: ConnectionCheck;
}>();
const emit = defineEmits<{
    navigate: [page: "projects" | "connect" | "maintenance"];
    add: [];
    start: [mode: "local" | "public"];
    stop: [];
    check: [];
    repair: [];
}>();

const running = computed(() => props.status?.runtime.running === true);
const activeProjects = computed(() => props.projects.filter((item) => item.active));
const localUrl = computed(() => props.status?.runtime.runtime?.localUrl ?? "");
const publicUrl = computed(() => props.setup?.config.publicAccess ? `https://${props.setup.config.publicAccess.domain}/mcp` : "");
const configured = computed(() => Boolean(publicUrl.value && props.setup?.passwordConfigured));
const connectionDetail = computed(() => {
    if (props.result?.ready) return "检查已通过";
    if (!publicUrl.value) return "需要公网地址";
    if (!props.setup?.passwordConfigured) return "需要设置密码";
    return props.result ? "还有检查项需要处理" : "等待连接检查";
});
const liveMode = computed(() => props.status?.runtime.runtime?.mode === "local" ? "local" : props.status?.runtime.runtime?.mode === "public" ? "public" : undefined);
const preferredMode = computed(() => props.setup?.config.runtime?.mode ?? (publicUrl.value ? "public" : "local"));
const heroTitle = computed(() => running.value ? "你的 MCP 工作区正在运行" : "让本机项目随时可用");
const heroDescription = computed(() => running.value
    ? `aimcp 正在以${liveMode.value === "public" ? "公网" : "本机"}模式提供 MCP 服务。你可以在下方复制连接地址或管理项目。`
    : "添加本机项目并启动 MCP 服务。运行状态、连接方式和项目会在这里集中显示。");

function moveHeroSpotlight(event: PointerEvent): void {
    if (event.pointerType !== "mouse") return;
    const element = event.currentTarget as HTMLElement;
    const bounds = element.getBoundingClientRect();
    element.style.setProperty("--spot-x", `${event.clientX - bounds.left}px`);
    element.style.setProperty("--spot-y", `${event.clientY - bounds.top}px`);
}

function resetHeroSpotlight(event: PointerEvent): void {
    const element = event.currentTarget as HTMLElement;
    element.style.removeProperty("--spot-x");
    element.style.removeProperty("--spot-y");
}

async function copyUrl(url: string, label: string): Promise<void> {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); ElMessage.success(`${label}已复制`); }
    catch { ElMessage.error("复制失败，请手动复制"); }
}
</script>

<template>
    <div class="home-dashboard">
        <section class="home-hero" :class="{ 'is-running': running }" @pointermove="moveHeroSpotlight" @pointerleave="resetHeroSpotlight">
            <div class="home-hero-copy">
                <div class="home-hero-kicker">
                    <span class="hero-live-dot" :class="{ 'is-online': running }"></span>
                    <span>{{ running ? "MCP 服务运行中" : "本机工作区" }}</span>
                    <span class="hero-kicker-divider"></span>
                    <span class="hero-kicker-subtle">{{ running ? (liveMode === "public" ? "公网模式" : "本机模式") : `aimcp · v${status?.version ?? "—"}` }}</span>
                </div>
                <h1>{{ heroTitle }}</h1>
                <p>{{ heroDescription }}</p>
                <div class="home-hero-meta">
                    <span><i class="hero-meta-dot"></i>{{ activeProjects.length }} 个活动项目</span>
                    <span class="hero-meta-divider"></span>
                    <span>{{ conversationCount }} 个会话绑定</span>
                </div>
            </div>
            <div class="home-hero-art" aria-hidden="true">
                <span class="hero-orbit hero-orbit-outer"></span>
                <span class="hero-orbit hero-orbit-inner"></span>
                <span class="hero-orbit-glow"></span>
                <span class="hero-orbit-node hero-orbit-node-one"></span>
                <span class="hero-orbit-node hero-orbit-node-two"></span>
                <span class="hero-orbit-core">A</span>
            </div>
        </section>

        <div class="metric-grid">
            <el-card class="metric-card metric-card--service" shadow="never">
                <div class="metric-topline"><div class="metric-label">MCP 服务</div><span class="metric-mark">01</span></div>
                <div class="metric-value">{{ loading ? "…" : running ? "运行中" : "未启动" }}</div>
                <div class="metric-detail">{{ liveMode === "local" ? "当前仅本机可访问" : liveMode === "public" ? "本机与公网地址可用" : "启动后提供 MCP 地址" }}</div>
            </el-card>
            <el-card class="metric-card metric-card--remote" shadow="never">
                <div class="metric-topline"><div class="metric-label">公网连接</div><span class="metric-mark">02</span></div>
                <div class="metric-value">{{ configured ? "已配置" : "未配置" }}</div>
                <div class="metric-detail">{{ connectionDetail }}</div>
            </el-card>
            <el-card class="metric-card metric-card--projects" shadow="never">
                <div class="metric-topline"><div class="metric-label">活动项目</div><span class="metric-mark">03</span></div>
                <div class="metric-value">{{ activeProjects.length }}</div>
                <div class="metric-detail">{{ projects.length - activeProjects.length }} 个已停用</div>
            </el-card>
            <el-card class="metric-card metric-card--sessions" shadow="never">
                <div class="metric-topline"><div class="metric-label">会话绑定</div><span class="metric-mark">04</span></div>
                <div class="metric-value">{{ conversationCount }}</div>
                <div class="metric-detail">当前项目选择记录</div>
            </el-card>
        </div>

        <div class="content-grid home-content-grid">
            <el-card class="home-primary-card" shadow="never">
                <div class="section-heading">
                    <div><h2>服务与连接</h2><p>按当前状态选择操作，地址会在服务运行后显示。</p></div>
                    <span class="section-status" :class="{ 'is-online': running }"><i></i>{{ running ? "实时状态" : "等待启动" }}</span>
                </div>

                <div v-if="!activeProjects.length" class="inline-actions home-actions"><el-button type="primary" :icon="FolderAdd" @click="emit('add')">添加项目</el-button><span class="muted small">项目注册不会启动 MCP 服务。</span></div>
                <div v-else-if="!running && !configured" class="inline-actions home-actions"><el-button type="primary" :icon="Link" @click="emit('navigate', 'connect')">配置公网连接</el-button><el-button :icon="VideoPlay" :loading="busy" @click="emit('start', 'local')">本机启动</el-button></div>
                <div v-else-if="!running" class="inline-actions home-actions"><el-button type="primary" :icon="VideoPlay" :loading="busy" @click="emit('start', 'public')">启动公网服务</el-button><el-button :loading="busy" @click="emit('start', 'local')">本机启动</el-button><span class="muted small">默认：{{ preferredMode === 'public' ? '公网' : '本机' }}</span></div>
                <div v-else class="inline-actions home-actions"><el-button v-if="liveMode === 'local' && !configured" type="primary" :icon="Link" @click="emit('navigate', 'connect')">配置公网连接</el-button><el-button v-else-if="liveMode === 'local' && configured" type="primary" :loading="busy" @click="emit('start', 'public')">切换到公网</el-button><el-button v-else-if="liveMode === 'public'" :loading="busy" @click="emit('start', 'local')">切换到本机</el-button><el-button v-if="liveMode === 'public'" type="primary" :icon="Refresh" :loading="busy" @click="emit('check')">检查连接</el-button><el-button :icon="Tools" @click="emit('repair')">检查并修复</el-button><el-button text type="danger" :icon="VideoPause" :disabled="busy" @click="emit('stop')">停止服务</el-button></div>

                <div class="endpoint-section">
                    <div class="endpoint-section-title">MCP 连接地址</div>
                    <div class="endpoint-row">
                        <div class="endpoint-info">
                            <span class="endpoint-icon endpoint-icon--local">本</span>
                            <div><strong>本机 MCP 地址</strong><span>仅此设备可访问</span></div>
                        </div>
                        <code class="endpoint-url">{{ localUrl || (running ? "本机地址暂不可用" : "服务启动后显示") }}</code>
                        <el-button v-if="localUrl" text :icon="CopyDocument" aria-label="复制本机 MCP 地址" @click="copyUrl(localUrl, '本机 MCP 地址')">复制</el-button>
                    </div>
                    <div class="endpoint-row">
                        <div class="endpoint-info">
                            <span class="endpoint-icon endpoint-icon--public">网</span>
                            <div><strong>公网 MCP 地址</strong><span>供远程客户端连接</span></div>
                        </div>
                        <code class="endpoint-url">{{ publicUrl || "尚未配置" }}</code>
                        <el-button v-if="publicUrl" text :icon="CopyDocument" aria-label="复制公网 MCP 地址" @click="copyUrl(publicUrl, '公网 MCP 地址')">复制</el-button>
                    </div>
                </div>

                <div class="home-projects-row">
                    <div class="endpoint-section-title">当前项目</div>
                    <div v-if="activeProjects.length" class="project-tags"><el-tag v-for="project in activeProjects.slice(0, 5)" :key="project.id" effect="plain" @click="emit('navigate', 'projects')">{{ project.name }}</el-tag><el-button v-if="activeProjects.length > 5" text @click="emit('navigate', 'projects')">+{{ activeProjects.length - 5 }}</el-button></div>
                    <span v-else class="muted small">尚未添加项目</span>
                </div>
            </el-card>

            <el-card class="home-status-card" shadow="never">
                <div class="section-heading"><div><h2>运行状态</h2><p>控制面与远程连接配置</p></div></div>
                <div class="status-list">
                    <div class="status-line"><span class="status-label">本机 Controller</span><el-tag type="success" effect="light">运行中</el-tag></div>
                    <div class="status-line"><span class="status-label">MCP Runtime</span><el-tag :type="running ? 'success' : 'info'" effect="light">{{ running ? (liveMode === 'public' ? '公网运行中' : '本机运行中') : '未启动' }}</el-tag></div>
                    <div class="status-line"><span class="status-label">默认启动模式</span><el-tag effect="plain">{{ preferredMode === 'public' ? '公网' : '本机' }}</el-tag></div>
                    <div class="status-line"><span class="status-label">公网连接</span><el-tag :type="publicUrl ? 'success' : 'warning'" effect="light">{{ publicUrl ? '已配置' : '未配置' }}</el-tag></div>
                    <div class="status-line"><span class="status-label">连接密码</span><el-tag :type="setup?.passwordConfigured ? 'success' : 'warning'" effect="light">{{ setup?.passwordConfigured ? '已设置' : '未设置' }}</el-tag></div>
                </div>
                <el-button class="status-settings-button" text @click="emit('navigate', 'connect')">管理连接设置 <span aria-hidden="true">→</span></el-button>
            </el-card>
        </div>

        <ConnectionResult class="home-connection-result" :result="result" @action="(action) => action === 'start' ? emit('start', configured ? 'public' : 'local') : action === 'projects' ? emit('add') : action === 'repair' ? emit('repair') : emit('navigate', 'connect')" />
    </div>
</template>
