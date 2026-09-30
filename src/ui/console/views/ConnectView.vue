<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Connection, CopyDocument, Key, MagicStick, Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus/es/components/message/index";
import "element-plus/es/components/message/style/css";
import type { ConnectionCheck, OperationSnapshot, SetupSummary } from "../api.js";
import ConnectionResult from "../components/ConnectionResult.vue";
import OperationPanel from "../components/OperationPanel.vue";

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

watch(() => props.zones, (values) => { if (values.length && !values.includes(zone.value)) zone.value = values[0] ?? ""; }, { immediate: true });

async function copy(value: string): Promise<void> {
    try { await navigator.clipboard.writeText(value); ElMessage.success("已复制到剪贴板"); }
    catch { ElMessage.error("复制失败，请手动复制"); }
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
    <div class="connect-page">
        <div class="page-heading connect-page-heading">
            <div class="page-heading-copy"><span class="page-eyebrow">02 / SECURE ACCESS</span><h1>连接</h1><p>配置远程 MCP 入口、访问密码，并运行连接检查。</p></div>
            <div class="connect-readiness"><span class="connect-readiness-light" :class="{ 'is-ready': access && setup?.passwordConfigured }"></span><div><strong>{{ access && setup?.passwordConfigured ? "远程接入已配置" : "远程接入待配置" }}</strong><span>地址 · 密码 · 连通性检查</span></div></div>
        </div>

        <div class="stack connect-stack">
            <el-card class="connect-step-card connect-address-card" shadow="never">
                <div class="section-heading">
                    <div class="connect-step-heading"><span class="connect-step-index">01</span><div><h2>公网入口</h2><p>{{ access ? "连接地址已经准备好。" : "推荐使用 Cloudflare 自动配置，也可以填写现有 HTTPS 域名。" }}</p></div></div>
                    <el-tag :type="access ? 'success' : 'warning'">{{ access ? "已配置" : "未配置" }}</el-tag>
                </div>
                <div v-if="publicUrl" class="copy-box"><el-icon><Connection /></el-icon><code>{{ publicUrl }}</code><el-button text :icon="CopyDocument" @click="copy(publicUrl)" /></div>
                <div class="inline-actions" style="margin-top: 16px">
                    <el-button type="primary" :icon="MagicStick" @click="cloudflareOpen = true">Cloudflare 自动配置</el-button>
                    <el-button @click="externalOpen = true">使用自己的域名</el-button>
                </div>
                <OperationPanel :operation="operation" @cancel="emit('cancelOperation', $event)" />
            </el-card>

            <el-card class="connect-step-card connect-password-card" shadow="never">
                <div class="section-heading"><div class="connect-step-heading"><span class="connect-step-index">02</span><div><h2>连接密码</h2><p>公网 MCP 请求需要密码；Web Console 始终只允许本机访问。</p></div></div><el-tag :type="setup?.passwordConfigured ? 'success' : 'warning'">{{ setup?.passwordConfigured ? "已设置" : "未设置" }}</el-tag></div>
                <div class="inline-actions"><el-button :icon="Key" @click="passwordOpen = true">{{ setup?.passwordConfigured ? "更换密码" : "设置密码" }}</el-button><el-button text @click="generate">生成并设置安全密码</el-button></div>
                <el-alert v-if="generatedPassword" style="margin-top: 14px" type="warning" :closable="false"><template #title>密码已经设置，请立即保存明文</template><div class="copy-box" style="margin-top: 8px"><code>{{ generatedPassword }}</code><el-button text :icon="CopyDocument" @click="copy(generatedPassword)" /></div></el-alert>
            </el-card>

            <el-card class="connect-step-card connect-check-card" shadow="never">
                <div class="section-heading"><div class="connect-step-heading"><span class="connect-step-index">03</span><div><h2>连通性检查</h2><p>确认公网地址、密码、Runtime 和项目都已经准备好。</p></div></div><el-button type="primary" :icon="Refresh" :loading="busy" @click="emit('check')">开始检查</el-button></div>
                <div v-if="!result" class="muted small">有问题时会直接告诉你下一步该处理什么。</div>
            </el-card>

            <ConnectionResult class="connect-result" :result="result" @action="emit('resultAction', $event)" />
        </div>

        <el-dialog v-model="cloudflareOpen" class="console-dialog cloudflare-dialog" title="Cloudflare 自动配置" width="min(520px, 92vw)">
            <template v-if="zones.length">
                <el-form label-position="top">
                    <el-form-item label="域名"><el-select v-model="zone" style="width: 100%"><el-option v-for="item in zones" :key="item" :label="item" :value="item" /></el-select></el-form-item>
                    <el-form-item label="子域名前缀"><el-input v-model="prefix" /><div class="muted small" style="margin-top: 6px">最终地址：{{ prefix || 'aimcp' }}.{{ zone || 'example.com' }}</div></el-form-item>
                    <el-form-item><el-checkbox v-model="overwrite">允许替换同名 DNS 记录</el-checkbox></el-form-item>
                </el-form>
            </template>
            <el-empty v-else description="读取 Cloudflare 账号中的可用域名；没有可用登录时会自动打开授权页"><el-button type="primary" :loading="busy" @click="emit('discover')">读取可用域名</el-button></el-empty>
            <template #footer><el-button @click="cloudflareOpen = false">取消</el-button><el-button v-if="zones.length" type="primary" :disabled="!zone || !prefix.trim() || busy" @click="cloudflareOpen = false; emit('applyCloudflare', zone, prefix, overwrite)">开始配置</el-button></template>
        </el-dialog>

        <el-dialog v-model="externalOpen" class="console-dialog" title="使用自己的域名" width="min(500px, 92vw)">
            <el-form label-position="top"><el-form-item label="HTTPS 域名"><el-input v-model="externalDomain" placeholder="mcp.example.com" /><div class="muted small" style="margin-top: 6px">只填写域名，不包含 https:// 或 /mcp。</div></el-form-item></el-form>
            <template #footer><el-button @click="externalOpen = false">取消</el-button><el-button type="primary" :disabled="!externalDomain.trim() || busy" @click="externalOpen = false; emit('applyExternal', externalDomain)">保存并检查</el-button></template>
        </el-dialog>

        <el-dialog v-model="passwordOpen" class="console-dialog" :title="setup?.passwordConfigured ? '更换连接密码' : '设置连接密码'" width="min(500px, 92vw)">
            <el-form label-position="top"><el-form-item label="新密码"><el-input v-model="password" type="password" show-password autocomplete="new-password" placeholder="至少 12 个字符" /></el-form-item></el-form>
            <template #footer><el-button @click="passwordOpen = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="password.length < 12" @click="saveConnectionPassword">保存密码</el-button></template>
        </el-dialog>
    </div>
</template>
