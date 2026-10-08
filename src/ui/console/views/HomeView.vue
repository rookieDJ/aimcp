<script setup lang="ts">
import { computed, ref } from "vue";
import { CopyDocument, FolderAdd, Link, VideoPause, VideoPlay, Refresh, Tools } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus/es/components/message/index";
import "element-plus/es/components/message/style/css";
import type { ConnectionCheck, ControllerStatus, Project, SetupSummary } from "../api.js";
import ConnectionResult from "../components/ConnectionResult.vue";
import SpotlightCard from "../components/SpotlightCard.vue";

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
const modeSelection = ref<"local" | "public">();
const startMode = computed(() => modeSelection.value ?? preferredMode.value);
const needsPublicSetup = computed(() => startMode.value === "public" && !configured.value);
const liveEndpoint = computed(() => liveMode.value === "local" ? localUrl.value : props.status?.runtime.runtime?.publicMcpUrl ?? "");
const workflowSteps = computed(() => [
    { label: "选择项目", detail: activeProjects.value.length ? `${activeProjects.value.length} 个项目可用` : "添加项目，或启用已停用项目", done: activeProjects.value.length > 0 },
    { label: "启动服务", detail: running.value ? `正在以${liveMode.value === 'local' ? '本机' : '公网'}模式运行` : needsPublicSetup.value ? "先配置公网地址与密码" : `以${startMode.value === 'local' ? '本机' : '公网'}模式启动`, done: running.value },
    { label: "获取连接地址", detail: running.value && liveEndpoint.value ? "复制地址，在 MCP 客户端中添加" : "启动后生成可用地址", done: running.value && Boolean(liveEndpoint.value) },
]);
const currentStep = computed(() => workflowSteps.value.findIndex(step => !step.done));
function selectStartMode(value: unknown): void { if (value === "local" || value === "public") modeSelection.value = value; }
const heroTitle = computed(() => running.value ? "你的 MCP 工作区正在运行" : "让本机项目随时可用");
const heroDescription = computed(() => running.value
    ? `aimcp 正在以${liveMode.value === "public" ? "公网" : "本机"}模式提供 MCP 服务。已接入的客户端可直接浏览代码、调用命令和管理外部技能。`
    : "添加本机代码项目并启动 MCP 服务。运行状态、公网隧道和会话绑定均在下方实时展示。");

async function copyUrl(url: string, label: string): Promise<void> {
    if (!url) return;
    try {
        await navigator.clipboard.writeText(url);
        ElMessage.success(`${label}已复制到剪贴板`);
    } catch {
        ElMessage.error("复制失败，请手动选择复制");
    }
}
</script>

<template>
    <div class="home-dashboard">
        <div class="page-heading home-heading">
            <div class="page-heading-copy"><h1 class="page-title">概览</h1><p>{{ heroDescription }}</p></div>
            <el-tag :type="running ? 'success' : 'info'" effect="plain">{{ heroTitle }}</el-tag>
        </div>
        <!-- Bento 4-Metric Grid -->
        <div class="metric-grid">
            <SpotlightCard class="metric-card metric-card--service">
                <div class="metric-card-inner">
                    <div class="metric-topline">
                        <div class="metric-label">MCP 服务状态</div>
                        <span class="metric-mark">01 // STATUS</span>
                    </div>
                    <div class="metric-value-row">
                        <span class="metric-value">{{ loading ? "…" : running ? "运行中" : "未启动" }}</span>
                        <span class="metric-indicator" :class="{ 'is-online': running }"></span>
                    </div>
                    <div class="metric-detail">{{ liveMode === "local" ? "当前仅本机可访问" : liveMode === "public" ? "公网隧道已开启" : "启动后提供 MCP 接入" }}</div>
                </div>
            </SpotlightCard>

            <SpotlightCard class="metric-card metric-card--remote">
                <div class="metric-card-inner">
                    <div class="metric-topline">
                        <div class="metric-label">公网接入</div>
                        <span class="metric-mark">02 // ACCESS</span>
                    </div>
                    <div class="metric-value-row">
                        <span class="metric-value">{{ configured ? "已配置" : "未配置" }}</span>
                        <span class="metric-indicator" :class="{ 'is-online': configured }"></span>
                    </div>
                    <div class="metric-detail">{{ connectionDetail }}</div>
                </div>
            </SpotlightCard>

            <SpotlightCard class="metric-card metric-card--projects">
                <div class="metric-card-inner">
                    <div class="metric-topline">
                        <div class="metric-label">已注册项目</div>
                        <span class="metric-mark">03 // PROJECTS</span>
                    </div>
                    <div class="metric-value-row">
                        <span class="metric-value">{{ activeProjects.length }}</span>
                        <span class="metric-sub-count">/ {{ projects.length }}</span>
                    </div>
                    <div class="metric-detail">{{ projects.length - activeProjects.length }} 个停用 · {{ conversationCount }} 个会话绑定</div>
                </div>
            </SpotlightCard>


        </div>

        <!-- Bento Content Grid: Primary Controls + System Telemetry -->
        <div class="home-bento-grid">
            <!-- Left Bento Column: Services, Actions & Endpoints -->
            <SpotlightCard class="bento-box bento-box--main">
                <div class="bento-box-inner">
                    <div class="bento-header">
                        <div class="bento-header-info">
                            <span class="bento-eyebrow">CONTROL & ENDPOINTS</span>
                            <h2>服务控制与连接地址</h2>
                            <p>管理 MCP 服务的启停模式，并在下方获取提供给客户端的地址。</p>
                        </div>
                        <span class="bento-status-pill" :class="{ 'is-online': running }">
                            <i class="status-dot"></i>
                            {{ running ? "实时运行" : "等待启动" }}
                        </span>
                    </div>

                    <ol class="startup-flow" aria-label="MCP 接入流程">
                        <li v-for="(step, index) in workflowSteps" :key="step.label" :class="{ 'is-done': step.done, 'is-current': index === currentStep }" :aria-current="index === currentStep ? 'step' : undefined">
                            <span class="flow-step-number">{{ step.done ? '✓' : index + 1 }}</span>
                            <div><strong>{{ step.label }}</strong><span>{{ step.detail }}</span></div>
                        </li>
                    </ol>
                    <div v-if="!running" class="startup-mode">
                        <span>启动模式</span>
                        <el-radio-group :model-value="startMode" aria-label="启动模式" :disabled="busy || loading || !setup" @change="selectStartMode">
                            <el-radio-button value="local">仅本机</el-radio-button>
                            <el-radio-button value="public">公网接入</el-radio-button>
                        </el-radio-group>
                        <span class="muted small">{{ startMode === 'local' ? '本机客户端直连，无需公网配置' : '远程客户端通过 HTTPS 与 OAuth 接入' }}</span>
                    </div>
                    <!-- Dynamic Action Buttons -->
                    <div class="home-actions-panel">
                        <div v-if="!activeProjects.length" class="inline-actions">
                            <el-button type="primary" :icon="FolderAdd" :disabled="busy || loading" @click="emit('add')">添加项目</el-button>
                            <el-button v-if="projects.length" @click="emit('navigate', 'projects')">管理并启用已有项目</el-button>
                            <span class="muted small">项目注册不会自动启动后台 MCP 服务。</span>
                        </div>
                        <div v-else-if="!running" class="inline-actions">
                            <el-button v-if="needsPublicSetup" type="primary" :icon="Link" :disabled="busy || loading || !setup" @click="emit('navigate', 'connect')">配置公网连接</el-button>
                            <el-button v-else type="primary" :icon="VideoPlay" :loading="busy" :disabled="loading || !setup" @click="emit('start', startMode)">{{ startMode === 'local' ? '启动本机服务' : '启动公网服务' }}</el-button>
                            <span class="muted small">已保存偏好：{{ preferredMode === 'public' ? '公网模式' : '本机模式' }}；切换选项后，启动时保存。</span>
                        </div>
                        <div v-else class="inline-actions">
                            <el-button v-if="liveEndpoint" type="primary" :icon="CopyDocument" @click="copyUrl(liveEndpoint, liveMode === 'local' ? '本机 MCP 地址' : '公网 MCP 地址')">复制当前 MCP 地址</el-button>
                            <el-button v-if="liveMode === 'local' && !configured" :icon="Link" @click="emit('navigate', 'connect')">配置公网连接</el-button>
                            <el-button v-else-if="liveMode === 'local' && configured" :loading="busy" @click="emit('start', 'public')">切换至公网模式</el-button>
                            <el-button v-else-if="liveMode === 'public'" :loading="busy" @click="emit('start', 'local')">切换至仅本机模式</el-button>
                            <el-button v-if="liveMode === 'public'" type="primary" :icon="Refresh" :loading="busy" @click="emit('check')">检查连通性</el-button>
                            <el-button :icon="Tools" @click="emit('repair')">检查并修复</el-button>
                            <el-button text type="danger" :icon="VideoPause" :disabled="busy" @click="emit('stop')">停止 MCP 服务</el-button>
                        </div>
                    </div>

                    <!-- Modern Endpoints Display -->
                    <div class="endpoint-bento-section">
                        <div class="endpoint-section-header">
                            <span class="endpoint-section-title">MCP 连接地址</span>
                            <span class="endpoint-section-hint">点击右侧按钮一键复制</span>
                        </div>

                        <div class="endpoint-card endpoint-card--local">
                            <div class="endpoint-info">
                                <span class="endpoint-badge endpoint-badge--local">LOCAL</span>
                                <div class="endpoint-meta">
                                    <strong>本机地址</strong>
                                    <span>仅当前这台电脑上的客户端可直连访问</span>
                                </div>
                            </div>
                            <div class="endpoint-action-group">
                                <code class="endpoint-code">{{ localUrl || (running ? "本机地址准备中…" : "服务启动后生成") }}</code>
                                <el-button
                                    v-if="localUrl"
                                    text
                                    class="endpoint-copy-btn"
                                    :icon="CopyDocument"
                                    @click="copyUrl(localUrl, '本机 MCP 地址')"
                                >复制</el-button>
                            </div>
                        </div>

                        <div class="endpoint-card endpoint-card--public">
                            <div class="endpoint-info">
                                <span class="endpoint-badge endpoint-badge--public">PUBLIC</span>
                                <div class="endpoint-meta">
                                    <strong>公网地址</strong>
                                    <span>供 ChatGPT 或远程 Gemini 应用接入</span>
                                </div>
                            </div>
                            <div class="endpoint-action-group">
                                <code class="endpoint-code">{{ publicUrl || "尚未配置公网入口" }}</code>
                                <el-button
                                    v-if="publicUrl"
                                    text
                                    class="endpoint-copy-btn"
                                    :icon="CopyDocument"
                                    @click="copyUrl(publicUrl, '公网 MCP 地址')"
                                >复制</el-button>
                            </div>
                        </div>
                    </div>

                    <!-- Quick Project Access -->
                    <div class="home-projects-quickview">
                        <span class="quickview-title">活动项目快捷入口</span>
                        <div v-if="activeProjects.length" class="project-tags-list">
                            <el-tag
                                v-for="project in activeProjects.slice(0, 6)"
                                :key="project.id"
                                class="project-pill-tag"
                                effect="plain"
                                @click="emit('navigate', 'projects')"
                            >

                                {{ project.name }}
                            </el-tag>
                            <el-button
                                v-if="activeProjects.length > 6"
                                text
                                size="small"
                                class="project-more-btn"
                                @click="emit('navigate', 'projects')"
                            >
                                +{{ activeProjects.length - 6 }} 更多项目
                            </el-button>
                        </div>
                        <span v-else class="muted small">尚未添加任何项目目录</span>
                    </div>
                </div>
            </SpotlightCard>

            <!-- Right Bento Column: System Telemetry -->
            <SpotlightCard class="bento-box bento-box--telemetry">
                <div class="bento-box-inner">
                    <div class="bento-header">
                        <div class="bento-header-info">
                            <span class="bento-eyebrow">TELEMETRY</span>
                            <h2>运行态详情</h2>
                            <p>控制面与隧道配置</p>
                        </div>
                    </div>

                    <div class="telemetry-list">
                        <div class="telemetry-row">
                            <div class="telemetry-info">
                                <span class="telemetry-label">本机 Controller</span>
                                <span class="telemetry-desc">负责配置与控制面管理</span>
                            </div>
                            <el-tag type="success" effect="light" class="telemetry-tag">
                                <span class="badge-dot is-online"></span>在线
                            </el-tag>
                        </div>

                        <div class="telemetry-row">
                            <div class="telemetry-info">
                                <span class="telemetry-label">MCP Runtime</span>
                                <span class="telemetry-desc">负责执行工具与会话</span>
                            </div>
                            <el-tag :type="running ? 'success' : 'info'" effect="light" class="telemetry-tag">
                                <span class="badge-dot" :class="{ 'is-online': running }"></span>
                                {{ running ? (liveMode === 'public' ? '公网运行中' : '本机运行中') : '未启动' }}
                            </el-tag>
                        </div>

                        <div class="telemetry-row">
                            <div class="telemetry-info">
                                <span class="telemetry-label">默认启动偏好</span>
                                <span class="telemetry-desc">无参数 start 时的行为</span>
                            </div>
                            <el-tag effect="plain" class="telemetry-tag mono">{{ preferredMode === 'public' ? '公网模式' : '本机模式' }}</el-tag>
                        </div>

                        <div class="telemetry-row">
                            <div class="telemetry-info">
                                <span class="telemetry-label">公网入口配置</span>
                                <span class="telemetry-desc">Cloudflare 或反代域名</span>
                            </div>
                            <el-tag :type="publicUrl ? 'success' : 'warning'" effect="light" class="telemetry-tag">
                                {{ publicUrl ? '已配置' : '未配置' }}
                            </el-tag>
                        </div>

                        <div class="telemetry-row">
                            <div class="telemetry-info">
                                <span class="telemetry-label">连接密码保护</span>
                                <span class="telemetry-desc">远程请求安全凭据</span>
                            </div>
                            <el-tag :type="setup?.passwordConfigured ? 'success' : 'warning'" effect="light" class="telemetry-tag">
                                {{ setup?.passwordConfigured ? '已设置' : '未设置' }}
                            </el-tag>
                        </div>
                    </div>

                    <div class="telemetry-footer">
                        <el-button class="telemetry-link-btn" text @click="emit('navigate', 'connect')">
                            配置公网连接与密码
                            <span class="arrow-icon">→</span>
                        </el-button>
                    </div>
                </div>
            </SpotlightCard>
        </div>

        <!-- Connection Result Check -->
        <ConnectionResult
            class="home-connection-result"
            :result="result"
            @action="(action) => action === 'start' ? emit('start', configured ? 'public' : 'local') : action === 'projects' ? emit('add') : action === 'repair' ? emit('repair') : emit('navigate', 'connect')"
        />
    </div>
</template>
