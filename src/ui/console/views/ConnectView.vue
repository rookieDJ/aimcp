<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Connection, CopyDocument, Key, MagicStick, Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus/es/components/message/index";
import "element-plus/es/components/message/style/css";
import type { ConnectionCheck, OperationSnapshot, SetupSummary } from "../api.js";
import ConnectionResult from "../components/ConnectionResult.vue";
import OperationPanel from "../components/OperationPanel.vue";
import SpotlightCard from "../components/SpotlightCard.vue";

const props = defineProps<{
    setup?: SetupSummary;
    result?: ConnectionCheck;
    operation?: OperationSnapshot;
    zones: string[];
    busy: boolean;
    savePassword: (password: string) => Promise<void>;
    generatePassword: () => Promise<string | undefined>;
}>();
const emit = defineEmits<{
    check: [];
    discover: [];
    applyCloudflare: [zone: string, prefix: string, overwrite: boolean];
    applyExternal: [domain: string];
    cancelOperation: [id: string];
    resultAction: [action: "start" | "connect" | "projects" | "repair"];
}>();

const cloudflareOpen = ref(false);
const externalOpen = ref(false);
const passwordOpen = ref(false);
const zone = ref("");
const prefix = ref("aimcp");
const overwrite = ref(false);
const externalDomain = ref("");
const password = ref("");
const generatedPassword = ref("");

const access = computed(() => props.setup?.config.publicAccess);
const publicUrl = computed(() => access.value ? `https://${access.value.domain}/mcp` : "");

watch(() => props.zones, (values) => {
    if (values.length && !values.includes(zone.value)) zone.value = values[0] ?? "";
}, { immediate: true });

async function copy(value: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(value);
        ElMessage.success("已复制到剪贴板");
    } catch {
        ElMessage.error("复制失败，请手动选择复制");
    }
}

async function saveConnectionPassword(): Promise<void> {
    await props.savePassword(password.value);
    password.value = "";
    passwordOpen.value = false;
}

async function generate(): Promise<void> {
    const value = await props.generatePassword();
    if (value) generatedPassword.value = value;
}
</script>

<template>
    <div class="connect-view">
        <div class="page-heading connect-page-heading">
            <div class="page-heading-copy">
                <h1 class="page-title">连接</h1>
                <p>配置安全公网隧道、接入凭据密码，并一键完成连通性端到端诊断。</p>
            </div>
            <div class="connect-readiness-badge" :class="{ 'is-ready': access && setup?.passwordConfigured }">
                <span class="readiness-dot"></span>
                <div class="readiness-texts">
                    <strong>{{ access && setup?.passwordConfigured ? "公网配置已完成" : "公网配置待完成" }}</strong>
                    <span>{{ access && setup?.passwordConfigured ? "隧道与密码已配置完成" : "需完成地址与密码设置" }}</span>
                </div>
            </div>
        </div>

        <div class="connect-bento-stack">
            <!-- Step 01: Public Ingress -->
            <SpotlightCard class="connect-step-card connect-step-card--ingress">
                <div class="step-card-inner">
                    <div class="step-header">
                        <div class="step-title-area">
                            <span class="connect-step-index">01</span><div><h2>公网入口</h2><p>{{ access ? "连接地址已经准备好。" : "推荐使用 Cloudflare 自动配置，也可以填写现有 HTTPS 域名。" }}</p></div>
                        </div>
                        <el-tag :type="access ? 'success' : 'warning'" effect="light" class="step-status-tag">
                            <span class="badge-dot" :class="{ 'is-online': access }"></span>
                            {{ access ? "入口已配置" : "尚未配置" }}
                        </el-tag>
                    </div>

                    <div v-if="publicUrl" class="endpoint-terminal-box">
                        <div class="terminal-bar">
                            <span class="terminal-dots"><i></i><i></i><i></i></span>
                            <span class="terminal-title">PUBLIC MCP ENDPOINT</span>
                        </div>
                        <div class="terminal-content">
                            <el-icon class="terminal-icon"><Connection /></el-icon>
                            <code class="terminal-url">{{ publicUrl }}</code>
                            <el-button text class="terminal-copy-btn" :icon="CopyDocument" @click="copy(publicUrl)">复制</el-button>
                        </div>
                    </div>

                    <div class="step-actions">
                        <el-button type="primary" :icon="MagicStick" class="action-btn--primary" @click="cloudflareOpen = true">
                            Cloudflare 自动配置
                        </el-button>
                        <el-button class="action-btn" @click="externalOpen = true">
                            使用自己的 HTTPS 域名
                        </el-button>
                    </div>

                    <OperationPanel :operation="operation" @cancel="emit('cancelOperation', $event)" />
                </div>
            </SpotlightCard>

            <!-- Step 02: Password Protection -->
            <SpotlightCard class="connect-step-card connect-step-card--auth">
                <div class="step-card-inner">
                    <div class="step-header">
                        <div class="step-title-area">
                            <span class="connect-step-index">02</span><div><h2>连接密码</h2><p>公网 MCP 请求需要密码；Web Console 始终只允许本机访问。</p></div>
                        </div>
                        <el-tag :type="setup?.passwordConfigured ? 'success' : 'warning'" effect="light" class="step-status-tag">
                            <span class="badge-dot" :class="{ 'is-online': setup?.passwordConfigured }"></span>
                            {{ setup?.passwordConfigured ? "已启用密码" : "未设置密码" }}
                        </el-tag>
                    </div>

                    <div class="step-actions">
                        <el-button :icon="Key" class="action-btn" @click="passwordOpen = true">
                            {{ setup?.passwordConfigured ? "更换连接密码" : "设置连接密码" }}
                        </el-button>
                        <el-button text class="action-btn--text" @click="generate">
                            一键生成并启用高强度随机密码
                        </el-button>
                    </div>

                    <el-alert
                        v-if="generatedPassword"
                        class="generated-password-alert"
                        type="warning"
                        :closable="false"
                    >
                        <template #title>
                            <span class="alert-title-strong">新密码已生效！请务必立即妥善保存明文：</span>
                        </template>
                        <div class="password-display-box">
                            <code class="password-code">{{ generatedPassword }}</code>
                            <el-button text :icon="CopyDocument" @click="copy(generatedPassword)">复制密码</el-button>
                        </div>
                    </el-alert>
                </div>
            </SpotlightCard>

            <!-- Step 03: Connectivity Probe -->
            <SpotlightCard class="connect-step-card connect-step-card--probe">
                <div class="step-card-inner">
                    <div class="step-header">
                        <div class="step-title-area">
                            <span class="connect-step-index">03</span><div><h2>连通性检查</h2><p>确认公网地址、密码、Runtime 和项目都已经准备好。</p></div>
                        </div>
                        <el-button
                            type="primary"
                            :icon="Refresh"
                            :loading="busy"
                            class="action-btn--primary"
                            @click="emit('check')"
                        >
                            开始全面检查
                        </el-button>
                    </div>
                    <div v-if="!result" class="step-hint muted small">
                        检查过程会进行真实公网探测并给出针对性的下一步修复建议。
                    </div>
                </div>
            </SpotlightCard>

            <!-- Connection Probe Result -->
            <ConnectionResult class="connect-result" :result="result" @action="emit('resultAction', $event)" />
        </div>

        <!-- Cloudflare Setup Dialog -->
        <el-dialog
            v-model="cloudflareOpen"
            class="console-dialog cloudflare-dialog"
            title="Cloudflare Tunnel 自动配置"
            width="min(540px, 92vw)"
        >
            <template v-if="zones.length">
                <el-form label-position="top">
                    <el-form-item label="选择 Cloudflare 域名 (Zone)">
                        <el-select v-model="zone" style="width: 100%">
                            <el-option v-for="item in zones" :key="item" :label="item" :value="item" />
                        </el-select>
                    </el-form-item>
                    <el-form-item label="自定义子域名前缀">
                        <el-input v-model="prefix" placeholder="aimcp" />
                        <div class="form-item-hint muted small">
                            完整公网地址将为：<code class="mono-pill">https://{{ prefix || 'aimcp' }}.{{ zone || 'example.com' }}/mcp</code>
                        </div>
                    </el-form-item>
                    <el-form-item>
                        <el-checkbox v-model="overwrite">允许自动替换同名 DNS CNAME 记录</el-checkbox>
                    </el-form-item>
                </el-form>
            </template>

            <el-empty
                v-else
                description="读取 Cloudflare 账号中已接入的可用域名；尚未登录时会自动弹出浏览器授权页。"
                class="dialog-empty"
            >
                <el-button type="primary" :loading="busy" @click="emit('discover')">授权并读取可用域名</el-button>
            </el-empty>

            <template #footer>
                <el-button @click="cloudflareOpen = false">取消</el-button>
                <el-button
                    v-if="zones.length"
                    type="primary"
                    :disabled="!zone || !prefix.trim() || busy"
                    @click="cloudflareOpen = false; emit('applyCloudflare', zone, prefix, overwrite)"
                >
                    开始部署 Tunnel
                </el-button>
            </template>
        </el-dialog>

        <!-- External Domain Dialog -->
        <el-dialog
            v-model="externalOpen"
            class="console-dialog"
            title="使用已有 HTTPS 反向代理域名"
            width="min(500px, 92vw)"
        >
            <el-form label-position="top">
                <el-form-item label="反代域名 (FQDN)">
                    <el-input v-model="externalDomain" placeholder="mcp.example.com" />
                    <div class="form-item-hint muted small">
                        仅需填写主机域名，无需包含 <code>https://</code> 或 <code>/mcp</code>。请确保反代已正确配置 TLS 证书。
                    </div>
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="externalOpen = false">取消</el-button>
                <el-button
                    type="primary"
                    :disabled="!externalDomain.trim() || busy"
                    @click="externalOpen = false; emit('applyExternal', externalDomain)"
                >
                    保存并验证
                </el-button>
            </template>
        </el-dialog>

        <!-- Password Modal Dialog -->
        <el-dialog
            v-model="passwordOpen"
            class="console-dialog"
            :title="setup?.passwordConfigured ? '更换远程接入密码' : '设置远程接入密码'"
            width="min(500px, 92vw)"
        >
            <el-form label-position="top">
                <el-form-item label="设置新密码 (Password)">
                    <el-input
                        v-model="password"
                        type="password"
                        show-password
                        autocomplete="new-password"
                        placeholder="请输入至少 12 位安全字符"
                    />
                    <div class="form-item-hint muted small">
                        密码在本地以安全 Argon2 哈希持久化，明文无法找回，请妥善保存。
                    </div>
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="passwordOpen = false">取消</el-button>
                <el-button
                    type="primary"
                    :loading="busy"
                    :disabled="password.length < 12"
                    @click="saveConnectionPassword"
                >
                    保存密码
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>
