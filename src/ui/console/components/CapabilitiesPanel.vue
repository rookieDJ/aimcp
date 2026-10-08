<script setup lang="ts">
import { ref, watch } from "vue";
import type { CapabilityConfig, SetupSummary } from "../api.js";

const props = defineProps<{
    setup?: SetupSummary;
    busy: boolean;
    saveCapabilities: (config: CapabilityConfig) => Promise<void>;
}>();

const capabilities = ref<CapabilityConfig>();
const dirty = ref(false);

watch(
    () => props.setup?.capabilities,
    (value) => {
        if (dirty.value) return;
        capabilities.value = value ? cloneCapabilityConfig(value) : undefined;
    },
    { immediate: true, deep: true },
);

function cloneCapabilityConfig(value: CapabilityConfig): CapabilityConfig {
    return {
        sync: value.sync,
        priority: [...value.priority],
        sources: Object.fromEntries(
            Object.entries(value.sources).map(([id, source]) => [id, { ...source }]),
        ),
    };
}

function updateSource(id: string, key: "enabled" | "mcp" | "skills", value: boolean): void {
    const config = capabilities.value;
    const source = config?.sources[id];
    if (!config || !source) return;
    config.sources[id] = { ...source, [key]: value };
    dirty.value = true;
}
function updateSync(value: boolean): void {
    if (!capabilities.value) return;
    capabilities.value.sync = value ? "watch" : "startup";
    dirty.value = true;
}
function resetDraft(): void {
    capabilities.value = props.setup?.capabilities ? cloneCapabilityConfig(props.setup.capabilities) : undefined;
    dirty.value = false;
}
async function save(): Promise<void> {
    if (!capabilities.value) return;
    await props.saveCapabilities(cloneCapabilityConfig(capabilities.value));
    dirty.value = false;
    capabilities.value = props.setup?.capabilities ? cloneCapabilityConfig(props.setup.capabilities) : capabilities.value;
}

function detected(id: string): boolean {
    return props.setup?.detections.some((item) => item.label.toLowerCase().includes(id === "agents" ? "agent" : id)) ?? false;
}
</script>

<template>
    <div class="capabilities-panel">
        <div class="section-heading">
            <div>
                <div class="inline-actions">
                    <h2>外部能力与技能整合 (External Tools)</h2>
                    <el-tag v-if="dirty" type="warning" size="small" effect="light" class="dirty-tag">
                        有未保存修改
                    </el-tag>
                </div>
                <p>实时读取本机已有的 Codex、Claude Code 以及 Agent Skills 配置文件，无需重复拷贝。</p>
            </div>
            <div class="inline-actions">
                <el-button v-if="dirty" text :disabled="busy" @click="resetDraft">放弃修改</el-button>
                <el-button type="primary" :disabled="!capabilities || !dirty || busy" @click="save">
                    保存能力配置
                </el-button>
            </div>
        </div>

        <template v-if="capabilities">
            <!-- Sync mode switch card -->
            <div class="capability-card capability-card--sync">
                <div class="capability-card-inner">
                    <div class="capability-card-left">
                        <div class="capability-card-title">
                            <strong>实时文件变动监听 (Live Watch)</strong>
                            <span class="capability-badge">AUTO SYNC</span>
                        </div>
                        <div class="capability-desc muted small">
                            开启后，当外部开发工具的技能文件发生更新时将自动同步至 aimcp，无需重启 MCP 服务。
                        </div>
                    </div>
                    <el-switch :model-value="capabilities.sync === 'watch'" @change="updateSync(Boolean($event))" />
                </div>
            </div>

            <!-- Provider Sources Bento Grid -->
            <div class="capabilities-grid">
                <div v-for="id in ['agents', 'codex', 'claude']" :key="id" class="capability-card capability-card--source">
                    <div class="capability-card-inner">
                        <div class="capability-card-left">
                            <div class="capability-card-title">
                                <strong>{{ id === 'agents' ? 'Agent Skills' : id === 'codex' ? 'Codex' : 'Claude Code' }}</strong>
                                <el-tag v-if="detected(id)" size="small" effect="light" type="success" class="detected-tag">
                                    ✓ 已在电脑中检测到
                                </el-tag>
                            </div>
                            <div class="capability-desc muted small">
                                允许 aimcp 读取 {{ id === 'agents' ? '~/.agents/skills' : id === 'codex' ? '~/.codex' : '~/.claude' }} 的能力。
                            </div>
                        </div>
                        <el-switch :model-value="capabilities.sources[id]?.enabled ?? false" @change="updateSource(id, 'enabled', Boolean($event))" />
                    </div>

                    <div v-if="capabilities.sources[id]?.enabled" class="capability-sub-options">
                        <el-checkbox
                            v-if="id !== 'agents'"
                            :model-value="capabilities.sources[id]?.mcp ?? false"
                            @change="updateSource(id, 'mcp', Boolean($event))"
                        >
                            透传 MCP 工具
                        </el-checkbox>
                        <el-checkbox
                            :model-value="capabilities.sources[id]?.skills ?? false"
                            @change="updateSource(id, 'skills', Boolean($event))"
                        >
                            读取 Skills 技能包
                        </el-checkbox>
                    </div>
                </div>
            </div>
        </template>
        <el-skeleton v-else :rows="3" animated />
    </div>
</template>
