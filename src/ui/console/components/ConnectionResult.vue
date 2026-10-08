<script setup lang="ts">
import { CircleCheck, WarningFilled, Clock } from "@element-plus/icons-vue";
import type { ConnectionCheck } from "../api.js";
import SpotlightCard from "./SpotlightCard.vue";

defineProps<{ result?: ConnectionCheck }>();
const emit = defineEmits<{ action: [value: "start" | "connect" | "projects" | "repair"] }>();

function iconFor(state: ConnectionCheck["checks"][number]["state"]) {
    return state === "passed" ? CircleCheck : state === "failed" ? WarningFilled : Clock;
}
function colorFor(state: ConnectionCheck["checks"][number]["state"]): string {
    return state === "passed" ? "var(--accent-green, #22c55e)" : "var(--accent-amber, #f59e0b)";
}
</script>

<template>
    <SpotlightCard v-if="result" class="connection-result-card" :spotlight-color="result.ready ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)'">
        <div class="result-card-inner">
            <div class="result-card-header">
                <div class="result-header-text">
                    <span class="result-kicker">CONNECTIVITY REPORT</span>
                    <h2>{{ result.ready ? "端到端连通性检查全部通过" : "连通性检查未完全通过" }}</h2>
                    <p>{{ result.ready ? "公网反向探测成功，MCP 服务已就绪，可直接在 ChatGPT 或 Gemini 中调用。" : "检测到待处理检查项，请根据下方提示调整后再次检查。" }}</p>
                </div>
                <el-tag :type="result.ready ? 'success' : 'warning'" effect="light" class="result-status-tag">
                    <span class="badge-dot" :class="{ 'is-online': result.ready }"></span>
                    {{ result.ready ? "全部就绪" : "待处理项" }}
                </el-tag>
            </div>

            <div class="checks-list">
                <div v-for="item in result.checks" :key="item.id" class="check-item-row" :class="`is-${item.state}`">
                    <div class="check-item-main">
                        <el-icon class="check-icon" :style="{ color: colorFor(item.state) }">
                            <component :is="iconFor(item.state)" />
                        </el-icon>
                        <div class="check-content">
                            <strong class="check-label">{{ item.label }}</strong>
                            <div class="check-detail muted small">{{ item.detail }}</div>
                        </div>
                    </div>
                    <el-button v-if="item.action" text type="primary" class="check-action-btn" @click="emit('action', item.action)">
                        去处理 →
                    </el-button>
                </div>
            </div>

            <div class="result-footer muted small">
                <span>检查时间：{{ new Date(result.checkedAt).toLocaleTimeString("zh-CN") }}</span>
            </div>
        </div>
    </SpotlightCard>
</template>
