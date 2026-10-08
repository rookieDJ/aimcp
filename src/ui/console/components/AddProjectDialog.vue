<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { FolderOpened, Folder, Select } from "@element-plus/icons-vue";
import { api, friendlyError, type ProjectSuggestion } from "../api.js";

const props = defineProps<{
    modelValue: boolean;
    busy: boolean;
    addProject: (path: string) => Promise<boolean>;
}>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const path = ref("");
const suggestions = ref<ProjectSuggestion[]>([]);
const manual = ref(false);
const picking = ref(false);
const error = ref("");
let pickerController: AbortController | undefined;

watch(() => props.modelValue, (open) => {
    if (!open) return;
    path.value = "";
    error.value = "";
    manual.value = false;
    void api<{ suggestions: ProjectSuggestion[] }>("/api/project-suggestions")
        .then((data) => { suggestions.value = data.suggestions; })
        .catch(() => { suggestions.value = []; });
});

onBeforeUnmount(() => pickerController?.abort());

async function choose(): Promise<void> {
    picking.value = true;
    error.value = "";
    const controller = new AbortController();
    pickerController = controller;
    try {
        const result = await api<{ path?: string; unavailable?: boolean }>("/api/project-folder", { method: "POST", body: {}, signal: controller.signal });
        if (result.path) path.value = result.path;
        if (result.unavailable) {
            manual.value = true;
            error.value = "无法直接调用系统目录选择窗口，请在下方选择自动发现的项目或手动输入项目完整路径。";
        }
    } catch (reason) {
        if (!controller.signal.aborted) error.value = friendlyError(reason);
    } finally {
        picking.value = false;
    }
}

async function add(): Promise<void> {
    if (await props.addProject(path.value)) emit("update:modelValue", false);
}
function close(): void {
    pickerController?.abort();
    if (!props.busy) emit("update:modelValue", false);
}
</script>

<template>
    <el-dialog
        :model-value="modelValue"
        class="console-dialog add-project-dialog"
        title="登记代码项目目录"
        width="min(560px, 92vw)"
        :close-on-click-modal="!busy"
        @close="close"
    >
        <div class="dialog-intro muted">
            选择本机需要交给 MCP 客户端访问的代码仓库文件夹。添加后客户端可在对话中绑定并操作该项目。
        </div>

        <el-button class="folder-picker-box" :class="{ 'is-picking': picking }" :disabled="picking || busy" @click="choose">
            <div class="folder-picker-icon">
                <el-icon :size="24"><FolderOpened /></el-icon>
            </div>
            <div class="folder-picker-copy">
                <strong>{{ picking ? "正在等待在系统选择窗口中确认…" : "点击唤起系统文件夹选择器" }}</strong>
                <span>支持任意本地 Git 项目、Node、Python 或通用代码目录</span>
            </div>
        </el-button>

        <div v-if="path" class="selected-path-box">
            <span class="selected-path-label">已选择有效目录：</span>
            <code class="selected-path-code">{{ path }}</code>
        </div>

        <div v-if="suggestions.length" class="suggestions-section">
            <div class="suggestions-header">
                <span class="suggestions-title">最近或自动发现的项目</span>
            </div>
            <el-scrollbar max-height="180px" class="suggestions-scrollbar">
                <div
                    v-for="item in suggestions"
                    :key="item.path"
                    class="suggestion-row"
                    :class="{ 'is-selected': path === item.path }"
                    @click="path = item.path; error = ''"
                >
                    <div class="suggestion-info">
                        <el-icon class="suggestion-icon"><Folder /></el-icon>
                        <div class="suggestion-texts">
                            <span class="suggestion-name">{{ item.name }}</span>
                            <code class="suggestion-path">{{ item.path }}</code>
                        </div>
                    </div>
                    <el-icon v-if="path === item.path" class="suggestion-check"><Select /></el-icon>
                </div>
            </el-scrollbar>
        </div>

        <div class="manual-input-toggle">
            <el-button text type="primary" size="small" @click="manual = !manual">
                {{ manual ? "隐藏手动输入路径" : "手动输入项目绝对路径" }}
            </el-button>
        </div>

        <el-input
            v-if="manual"
            v-model="path"
            placeholder="/Users/username/Projects/my-app"
            class="manual-path-input"
        />

        <el-alert v-if="error" class="dialog-error-alert" type="warning" :closable="false" :title="error" />

        <template #footer>
            <el-button :disabled="busy" @click="close">取消</el-button>
            <el-button
                type="primary"
                :loading="busy"
                :disabled="!path.trim() || picking"
                @click="add"
            >
                完成登记
            </el-button>
        </template>
    </el-dialog>
</template>
