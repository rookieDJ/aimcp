<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { FolderAdd, ChatDotRound, Delete, Folder, Search } from "@element-plus/icons-vue";
import type { Conversation, ConversationRecord, Project } from "../api.js";
import SpotlightCard from "../components/SpotlightCard.vue";
import ConversationHistory from "../components/ConversationHistory.vue";

const props = defineProps<{ projects: Project[]; conversations: Conversation[]; records: ConversationRecord[]; unavailableRecords: number; recordingEnabled: boolean; recordingReady: boolean; busy: boolean }>();
const emit = defineEmits<{
    add: [];
    recordingChange: [enabled: boolean];
    reactivate: [project: Project];
    remove: [project: Project];
    deactivate: [project: Project];
    cleanup: [project: Project, ids: string[]];
    deleteRecord: [record: ConversationRecord];
    renamed: [];
}>();

const drawerOpen = ref(false);
const history = ref<InstanceType<typeof ConversationHistory>>();
const historyProjectId = ref("");
const drawerProject = ref<Project>();
const activeConversations = computed(() => drawerProject.value ? props.conversations.filter((item) => item.projectId === drawerProject.value!.id) : []);
const activeProjectCount = computed(() => props.projects.filter((item) => item.active).length);
const projectQuery = ref("");
const registrationFilter = ref("all");
const filteredProjects = computed(() => {
    const query = projectQuery.value.trim().toLocaleLowerCase();
    return props.projects.filter(project =>
        (registrationFilter.value === "all" || project.active === (registrationFilter.value === "active")) &&
        (!query || `${project.name}\n${project.path}`.toLocaleLowerCase().includes(query)));
});
function clearProjectFilters(): void { projectQuery.value = ""; registrationFilter.value = "all"; }

function conversationCount(project: Project): number {
    return props.conversations.filter((item) => item.projectId === project.id).length;
}

function openProject(project: Project): void {
    drawerProject.value = project;
    drawerOpen.value = true;
}
function showHistory(project: Project): void { history.value?.focusProject(project.id); }
function showChat(id: string): void { drawerOpen.value = false; history.value?.showById(id); }
function recordCount(project: Project): number { return props.records.filter(item => item.projectId === project.id).length; }
function hasRecord(id: string): boolean { return props.records.some(item => item.id === id); }

watch(() => props.projects, (items) => {
    if (!drawerProject.value) return;
    const current = items.find((item) => item.id === drawerProject.value?.id);
    if (!current) {
        drawerOpen.value = false;
        drawerProject.value = undefined;
        return;
    }
    drawerProject.value = current;
}, { deep: true });
</script>

<template>
    <div class="projects-view">
        <div class="page-heading projects-heading">
            <div class="page-heading-copy">
                <h1 class="page-title">项目管理</h1>
                <p>管理 MCP 客户端可以访问的代码项目及各项目的独立对话绑定关系。</p>
            </div>
            <div class="projects-heading-side">
                <div class="projects-heading-stat">
                    <strong>{{ activeProjectCount }}</strong>
                    <span>个可用活动项目</span>
                </div>
                <el-button type="primary" :icon="FolderAdd" class="add-project-btn" @click="emit('add')">
                    添加项目
                </el-button>
            </div>
        </div>

        <SpotlightCard class="projects-bento-card">
            <div class="projects-card-inner">
                <div class="projects-card-header">
                    <div class="projects-header-left">
                        <span class="projects-card-kicker">REGISTERED DIRECTORIES</span>
                        <h2>已登记项目列表</h2>
                    </div>
                    <div class="projects-header-right">
                        <el-tag effect="plain" class="projects-count-tag">{{ projects.length }} 个项目</el-tag>
                    </div>
                </div>

                <div class="project-action-legend"><span><el-tag type="warning" size="small">停用</el-tag> 保留登记，可直接重新启用</span><span><el-tag type="danger" size="small">移除</el-tag> 取消登记，之后需重新添加</span><span class="muted small">两者均保留本地文件和已保存聊天历史。</span></div>

                <div v-if="projects.length" class="project-filter-bar">
                    <el-input v-model="projectQuery" clearable :prefix-icon="Search" placeholder="搜索项目名称或路径" aria-label="搜索项目名称或路径" />
                    <el-select v-model="registrationFilter" aria-label="筛选登记状态">
                        <el-option label="全部登记状态" value="all" />
                        <el-option label="可用项目" value="active" />
                        <el-option label="已停用项目" value="inactive" />
                    </el-select>
                    <span class="muted small" role="status">显示 {{ filteredProjects.length }} / {{ projects.length }} 个项目</span>
                </div>
                <el-empty v-if="projects.length && !filteredProjects.length" description="没有匹配的项目">
                    <el-button @click="clearProjectFilters">清除筛选</el-button>
                </el-empty>

                <el-empty
                    v-if="!projects.length"
                    description="暂未添加任何项目目录"
                    class="projects-empty-state"
                >
                    <el-button type="primary" :icon="FolderAdd" @click="emit('add')">选择本机项目文件夹</el-button>
                </el-empty>

                <el-table
                    v-if="filteredProjects.length"
                    class="project-desktop-table"
                    :data="filteredProjects"
                    style="width: 100%"
                    @row-click="openProject"
                >
                    <el-table-column label="项目与路径" min-width="320">
                        <template #default="{ row }">
                            <div class="project-identity-cell">
                                <div class="project-icon-box">
                                    <el-icon><Folder /></el-icon>
                                </div>
                                <div class="project-texts">
                                    <span class="project-name">{{ row.name }}</span>
                                    <code class="project-path">{{ row.path }}</code>
                                </div>
                            </div>
                        </template>
                    </el-table-column>

                    <el-table-column label="登记状态" width="120">
                        <template #default="{ row }">
                            <div class="project-status-pill" :class="{ 'is-active': row.active }">
                                <span class="status-dot"></span>
                                <span>{{ row.active ? "可用" : "已停用" }}</span>
                            </div>
                        </template>
                    </el-table-column>

                    <el-table-column label="会话 / 本地记录" width="190">
                        <template #default="{ row }">
                            <span class="session-count-badge">
                                <el-icon><ChatDotRound /></el-icon>
                                {{ conversationCount(row) }} 个会话
                            </span>
                            <div><el-button link type="primary" @click.stop="showHistory(row)">查看 {{ recordCount(row) }} 份会话记录</el-button></div>
                        </template>
                    </el-table-column>

                    <el-table-column label="操作" width="260" align="right" fixed="right">
                        <template #default="{ row }">
                            <div class="table-actions">
                                <el-button text type="primary" class="table-action-btn" @click.stop="openProject(row)">管理详情</el-button>
                                <el-button
                                    v-if="row.active"
                                    text
                                    type="warning"
                                    class="table-action-btn"
                                    :disabled="busy"
                                    @click.stop="emit('deactivate', row)"
                                >停用</el-button>
                                <el-button
                                    v-else
                                    text
                                    type="primary"
                                    class="table-action-btn"
                                    :disabled="busy"
                                    @click.stop="emit('reactivate', row)"
                                >启用</el-button>
                                <el-button text type="danger" :icon="Delete" class="table-action-btn" :disabled="busy" @click.stop="emit('remove', row)">移除</el-button>
                            </div>
                        </template>
                    </el-table-column>
                </el-table>

                <!-- Mobile Responsive Cards -->
                <div v-if="filteredProjects.length" class="project-mobile-list">
                    <article v-for="project in filteredProjects" :key="project.id" class="project-mobile-item">
                        <div class="project-mobile-heading">
                            <div class="project-mobile-identity">
                                <strong>{{ project.name }}</strong>
                                <code>{{ project.path }}</code>
                            </div>
                            <span class="project-status-pill" :class="{ 'is-active': project.active }">
                                <span class="status-dot"></span>
                                <span>{{ project.active ? "可用" : "已停用" }}</span>
                            </span>
                        </div>
                        <div class="project-mobile-footer">
                            <span class="session-count-badge">
                                <el-icon><ChatDotRound /></el-icon>
                                {{ conversationCount(project) }} 个会话
                            </span>
                            <div class="project-mobile-actions">
                                <el-button size="small" @click="openProject(project)">管理</el-button>
                                <el-button
                                    v-if="project.active"
                                    size="small"
                                    text
                                    type="warning"
                                    :disabled="busy"
                                    @click="emit('deactivate', project)"
                                >停用</el-button>
                                <el-button
                                    v-else
                                    size="small"
                                    text
                                    type="primary"
                                    :disabled="busy"
                                    @click="emit('reactivate', project)"
                                >启用</el-button>
                                <el-button size="small" text type="danger" :disabled="busy" @click="emit('remove', project)">移除</el-button>
                            </div>
                        </div>
                    </article>
                </div>
            </div>
        </SpotlightCard>

        <ConversationHistory ref="history" v-model:project-id="historyProjectId" :records="records" :unavailable="unavailableRecords" :recording-enabled="recordingEnabled" :recording-ready="recordingReady" :busy="busy" @recording-change="emit('recordingChange', $event)" @delete="emit('deleteRecord', $event)" @renamed="emit('renamed')" />

        <p v-if="conversations.length" class="projects-footnote muted small">
            会话编号只用于区分各客户端对话的项目选择绑定，不会影响客户端会话的实际连接状态。
        </p>

        <!-- Project Details Drawer -->
        <el-drawer
            v-model="drawerOpen"
            class="project-details-drawer"
            :title="drawerProject?.name ?? '项目详情'"
            size="min(520px, 92vw)"
        >
            <template v-if="drawerProject">
                <div class="project-drawer-meta">
                    <div class="meta-row">
                        <span class="meta-label">项目状态</span>
                        <span class="project-status-pill" :class="{ 'is-active': drawerProject.active }">
                            <span class="status-dot"></span>
                            <span>{{ drawerProject.active ? "可用" : "已停用" }}</span>
                        </span>
                    </div>
                    <div class="meta-row meta-row-endpoint">
                        <span class="meta-label">工作区目录</span>
                        <code class="meta-code break-all">{{ drawerProject.path }}</code>
                    </div>
                    <div class="meta-row meta-row-endpoint">
                        <span class="meta-label">项目标识 (ID)</span>
                        <code class="meta-code break-all">{{ drawerProject.id }}</code>
                    </div>
                </div>

                <div class="section-heading drawer-section-heading">
                    <div>
                        <h2>对话会话绑定</h2>
                        <p>解除后需重新选择项目。本地项目使用历史和已保存聊天保留。</p>
                    </div>
                    <el-button
                        v-if="activeConversations.length > 1"
                        text
                        type="danger"
                        :disabled="busy"
                        @click="emit('cleanup', drawerProject, activeConversations.map((item) => item.id))"
                    >
                        清理全部绑定
                    </el-button>
                </div>

                <el-empty
                    v-if="!activeConversations.length"
                    :image-size="60"
                    description="当前没有绑定会话；历史记录可在下方查看"
                    class="drawer-empty"
                />

                <div v-else class="drawer-conversations-list">
                    <div v-for="item in activeConversations" :key="item.id" class="conversation-item-card">
                        <div class="conversation-icon">
                            <el-icon><ChatDotRound /></el-icon>
                        </div>
                        <div class="conversation-info">
                            <div class="conversation-title">{{ item.displayTitle || `${item.label} · ${item.id.slice(0, 8)}` }}</div>
                            <div class="conversation-time muted small">最近交互：{{ new Date(item.lastSeenAt).toLocaleString("zh-CN") }}</div>
                            <el-button link type="primary" :disabled="!hasRecord(item.id)" @click="showChat(item.id)">{{ hasRecord(item.id) ? '查看本地聊天记录' : '暂无本地记录' }}</el-button>
                        </div>
                        <el-button
                            text
                            type="danger"
                            :icon="Delete"
                            :disabled="busy"
                            @click="emit('cleanup', drawerProject, [item.id])"
                        >解除</el-button>
                    </div>
                </div>

                <div class="drawer-footer-actions">
                    <el-button type="primary" plain class="drawer-action-btn" @click="drawerOpen = false; showHistory(drawerProject)">查看 {{ recordCount(drawerProject) }} 份历史会话记录</el-button>
                    <el-button
                        v-if="drawerProject.active"
                        type="warning"
                        plain
                        class="drawer-action-btn"
                        :disabled="busy"
                        @click="emit('deactivate', drawerProject)"
                    >
                        停用项目（保留登记）
                    </el-button>
                    <el-button
                        v-else
                        type="primary"
                        class="drawer-action-btn"
                        :disabled="busy"
                        @click="emit('reactivate', drawerProject)"
                    >
                        重新启用此项目
                    </el-button>
                    <el-button type="danger" plain :icon="Delete" class="drawer-action-btn" :disabled="busy" @click="emit('remove', drawerProject)">移除项目登记</el-button>
                </div>
            </template>
        </el-drawer>
    </div>
</template>
