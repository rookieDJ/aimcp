<script setup lang="ts">
import { computed } from "vue";
import { CircleCheck, Loading, WarningFilled, CircleClose } from "@element-plus/icons-vue";
import { friendlyError, type OperationSnapshot } from "../api.js";

const props = defineProps<{ operation?: OperationSnapshot }>();
const emit = defineEmits<{ cancel: [id: string] }>();

const presentation = computed(() => {
    const state = props.operation?.state;
    if (state === "succeeded") return { type: "success" as const, label: "已完成", icon: CircleCheck };
    if (state === "cancelled") return { type: "warning" as const, label: "已取消", icon: WarningFilled };
    if (state === "failed") return { type: "danger" as const, label: "未完成", icon: CircleClose };
    return { type: "info" as const, label: "执行中", icon: Loading };
});

function friendlyPhase(message: string): string {
    const exact: Record<string, string> = {
        "准备中": "正在准备",
        "运行诊断": "正在检查服务",
        "执行安全本机修复": "正在修复常见问题",
        "验证公网连接": "正在检查公网连接",
        "打开 Cloudflare 登录": "正在打开 Cloudflare 登录",
        "读取 Cloudflare 登录": "正在读取 Cloudflare 账户",
        "Cloudflare 域名已读取": "可用域名已读取",
        "正在取消": "正在取消",
        "完成": "操作已完成",
    };
    return exact[message] ?? message;
}
</script>

<template>
    <div v-if="operation" class="operation-panel-wrapper">
        <div class="operation-panel-box" :class="`is-${operation.state}`">
            <div class="operation-panel-top">
                <div class="operation-phase-indicator">
                    <el-icon class="phase-icon" :class="{ 'is-loading': operation.state === 'running' }">
                        <component :is="presentation.icon" />
                    </el-icon>
                    <span class="phase-text">{{ friendlyPhase(operation.phase) }}</span>
                    <el-tag :type="presentation.type" effect="light" class="phase-tag">{{ presentation.label }}</el-tag>
                </div>
                <el-button v-if="operation.state === 'running'" text type="danger" size="small" @click="emit('cancel', operation.id)">
                    终止操作
                </el-button>
            </div>

            <div v-if="operation.messages.length" class="operation-terminal-logs">
                <div v-for="(message, index) in operation.messages.slice(-8)" :key="`${index}-${message}`" class="log-line">
                    <span class="log-arrow">›</span>
                    <span class="log-msg">{{ friendlyPhase(message) }}</span>
                </div>
            </div>

            <el-alert
                v-if="operation.error"
                class="operation-error-banner"
                type="error"
                :closable="false"
                :title="friendlyError(operation.error)"
            />
        </div>
    </div>
</template>
