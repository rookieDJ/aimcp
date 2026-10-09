# aimcp

> 让 **ChatGPT**、**Google Gemini CLI** 或 **Gemini 网页端** 通过 MCP 协议，安全操作你电脑上的代码项目。

<p align="left">
  <img src="https://img.shields.io/badge/Node-%3E%3D22-brightgreen?logo=node.js&logoColor=white" alt="Node.js Version" />
  <img src="https://img.shields.io/badge/ChatGPT-Compatible-74aa9c?logo=openai&logoColor=white" alt="ChatGPT Compatible" />
  <img src="https://img.shields.io/badge/Gemini-Compatible-4285F4?logo=google&logoColor=white" alt="Gemini Compatible" />
  <img src="https://img.shields.io/badge/Protocol-MCP_Streamable_HTTP-blueviolet" alt="Protocol MCP" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License MIT" />
</p>

安装并连接后，你可以在 AI 对话中直接说：

- 💬 *“帮我看看当前项目是做什么的”*
- 💬 *“检查一下 git 状态，现在有哪些未提交改动”*
- 💬 *“修掉这个报错，并跑一下单元测试”*
- 💬 *“把这个功能实现完，然后切到 api 项目继续”*

`aimcp` 会在你的电脑上受控地读取文件、修改代码、执行构建与测试命令，并把结果实时返回给 AI。

---

## 📌 目录

- [一图看懂 aimcp](#-一图看懂-aimcp)
- [模式选择指南](#-模式选择指南本机模式-vs-公网模式)
- [快速开始](#-快速开始)
  - [1. 安装](#1-安装)
  - [2. 启动与控制台](#2-启动与管理控制台推荐)
  - [3. 接入 AI 客户端](#3-接入-ai-客户端)
    - [连接 Gemini CLI（本机最简）](#31-连接-gemini-cli本机模式推荐)
    - [连接 Gemini 网页版 / 移动端](#32-连接-gemini-网页版--移动端公网模式)
    - [连接 ChatGPT](#33-连接-chatgpt公网模式)
    - [连接 Codex CLI](#34-连接-codex-cli本机模式)
- [多项目工作流](#-多项目隔离与工作流)
- [精简 15 工具矩阵](#-15-个精简工具矩阵)
- [常用命令速查](#-常用命令速查)
- [外部能力与 Skills 导入](#-外部能力与-skills-导入)
- [故障排查与自愈决策树](#-故障排查与自愈决策树)
- [本地开发](#-本地开发)
- [安全说明](#-安全说明)

---

## 🗺️ 一图看懂 aimcp

`aimcp` 将控制面与运行时彻底解耦。多个工程目录、多个对话窗口，统一由一个轻量级后台守护进程提供服务：

```mermaid
graph TD
    subgraph Clients ["🤖 AI 客户端"]
        GeminiCLI["Gemini CLI / Codex CLI<br/>(同机本地命令行)"]
        WebAI["ChatGPT / Gemini 网页端<br/>(云端或移动端 App)"]
    end

    subgraph Channels ["🌐 传输模式"]
        Loopback["🟢 本机模式 (Local)<br/>http://127.0.0.1:3920/mcp<br/><i>免密码 · 零网络依赖</i>"]
        Cloudflare["🟣 公网接入模式 (Public)<br/>https://aimcp.your-domain.com/mcp<br/><i>自动 Cloudflare Tunnel · OAuth 2.0 密码鉴权</i>"]
    end

    subgraph Core ["⚙️ aimcp 守护进程 (Daemon)"]
        Controller["Web Console 控制台<br/><i>项目登记 / 状态诊断 / 日志</i>"]
        Router["会话项目路由器<br/>(project_control)"]
        ToolEngine["15 个精简原子工具<br/><i>代码读写 · 补丁事务 · 命令执行</i>"]
    end

    subgraph Projects ["💻 本机代码工程目录"]
        ProjA["📁 前端项目 (~/code/web)"]
        ProjB["📁 后端项目 (~/code/api)"]
        ProjC["📁 移动端项目 (~/code/app)"]
    end

    GeminiCLI --> Loopback --> Router
    WebAI --> Cloudflare --> Router
    Controller -.管理状态 / 启停.-> Core
    Router --> ToolEngine
    ToolEngine == 严格隔离 == ProjA
    ToolEngine == 严格隔离 == ProjB
    ToolEngine == 严格隔离 == ProjC
```

---

## 🧭 模式选择指南（本机模式 vs 公网模式）

无需纠结网络配置，先看看你使用的是哪种客户端：

| 你的使用场景 | 推荐模式 | 网络与环境要求 | 是否需要密码 | 对应客户端 | 启动命令 |
| :--- | :---: | :---: | :---: | :--- | :--- |
| **同机开发 / 纯本地 CLI** | 🟢 **本机模式 (`--local`)** | 纯本地回环 (127.0.0.1)<br>无需公网 IP 与域名 | ❌ 免密访问 | Gemini CLI<br>Codex CLI | `aimcp start --local` |
| **云端网页端 / 手机 App** | 🟣 **公网模式 (`--public`)** | HTTPS 域名入口<br>(支持自动创建 Cloudflare Tunnel) | ✅ 强密码鉴权 + OAuth | ChatGPT 网页版<br>Gemini 网页版/App | `aimcp start --public` |

---

## 🚀 快速开始

### 1. 安装

系统环境要求：**Node.js 22** 或更高版本。

```bash
# 全局安装 aimcp
npm install --global @rookiedj/aimcp

# 检查安装
aimcp --version
```

---

### 2. 启动与管理控制台（推荐）

打开图形化 Web 管理控制台：

```bash
aimcp open
```

控制台会自动在浏览器打开（默认 `http://127.0.0.1:3921`）。你可以在可视化界面中：
1. **添加项目**：点击“添加项目”选择你的代码工程目录。
2. **选择模式**：点击“启动模式”，选择 **仅本机** 或 **公网接入**。
3. **复制连接**：点击“启动服务”后，一键复制提供给 AI 客户端的 MCP 地址。

> **提示**：控制台是纯本地轻量服务，打开它**不会**自动触碰外网，也不会强制开启公网隧道。

---

### 3. 接入 AI 客户端

#### 3.1 连接 Gemini CLI（本机模式，推荐）

Gemini CLI 运行在同一台电脑上，直接走本地回环，速度最快、稳定性最高：

1. **在代码目录启动服务**（默认端口 `3920`）：
   ```bash
   cd /path/to/your-project
   aimcp start --local
   ```
2. **注册到 Gemini CLI 配置**：
   ```bash
   gemini mcp add --scope user --transport http aimcp http://127.0.0.1:3920/mcp
   ```
3. **验证连接**：
   ```bash
   gemini mcp list
   ```
   看到显示 `Connected` 后，重启 Gemini CLI，在会话中输入 `/mcp` 即可看到所有可用工具。详见 [Gemini CLI MCP 官方说明](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)。

---

#### 3.2 连接 Gemini 网页版 / 移动端（公网模式）

Google Gemini 网页端（gemini.google.com）运行在云端，需要一个安全的公网 HTTPS 入口：

1. **配置公网与连接密码**（首次使用配置一次即可）：
   ```bash
   aimcp setup
   ```
   跟随向导完成 Cloudflare 自动配置（只需已有 Cloudflare 托管域名）或填入自定义反向代理域名，并生成连接密码。
2. **以公网模式启动**：
   ```bash
   aimcp start --public
   aimcp status   # 复制输出的公网地址，例如：https://aimcp.your-domain.com/mcp
   ```
3. **在 Gemini 网页端添加应用**：
   - 打开 [Gemini 网页版](https://gemini.google.com/)，进入 **设置 → 个性化智能服务 → 已连接的应用**。
   - 在“自定义应用”中点击添加，粘贴公网 MCP 地址。
   - 在弹出的授权页面中输入连接密码完成授权。
   - 回到对话，输入 `@aimcp` 即可指派 AI 读写本地项目！

---

#### 3.3 连接 ChatGPT（公网模式）

1. 确保以公网模式运行：`aimcp start --public`。
2. 在 ChatGPT 账号设置中启用 **Developer Mode**（开发者模式）。
3. 进入 **Apps → Create**，填入你的公网 MCP 地址（如 `https://aimcp.your-domain.com/mcp`）。
4. 点击扫描工具（Scan Tools），按提示输入之前生成的连接密码完成 OAuth 验证并保存。

---

#### 3.4 连接 Codex CLI（本机模式）

```bash
aimcp start --local
codex mcp add aimcp --url http://127.0.0.1:3920/mcp
codex mcp list
```

---

## 🗂️ 多项目隔离与工作流

`aimcp` 支持一台电脑托管多个项目，无需为每个项目开辟新端口或新服务：

```text
┌─────────────────────────────────────────────────────────────┐
│                  同一个 aimcp 后台服务 (Port: 3920)           │
└──────────────────────────────┬──────────────────────────────┘
                               │ 会话级严格目录隔离
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
   ┌───────────┐         ┌───────────┐         ┌───────────┐
   │ 对话会话 1 │         │ 对话会话 2 │         │ 对话会话 3 │
   │ 绑定目录:   │         │ 绑定目录:   │         │ 绑定目录:   │
   │ ~/code/web│         │ ~/code/api│         │ ~/code/app│
   └───────────┘         └───────────┘         └───────────┘
   ▲ 读写、搜索、测试命令严格限制在各自主工作区内，防止误操作越界 ▲
```

### 项目操作口令：

1. **登记项目**：进入不同目录分别执行 `aimcp start`，或执行 `aimcp project add /path/to/project`。
2. **对话内选择**：初次对话时 AI 会调用 `project_control` 询问要操作哪个工程，你只需说：*“使用 web 项目”*。
3. **中途切换**：直接说：*“切换到 api 项目继续”*，AI 即可平滑换绑上下文。

---

## 🛠️ 15 个精简工具矩阵

为避免大模型在几十上百个琐碎工具中产生调用幻觉，`aimcp` 精选并收敛了 15 个高内聚工具：

| 类别 | 工具名 | 核心能力 | 典型使用场景 |
| :--- | :--- | :--- | :--- |
| 📂 **文件读写** | `read` | 带行号精确阅读单个或多个源码文件 | 查阅函数实现、排查报错位置 |
| | `read_image` | 安全读取并按需压缩工程内图片 | 前端 UI 效果对比、图表查阅 |
| | `apply_patch` | 事务式代码增删改（支持批量修改） | 编写功能实现、批量重构，出错自动回滚 |
| 🔍 **代码探索** | `ls` | 结构化遍历项目文件目录 | 探索工程骨架与模块结构 |
| | `grep` | 基于 ripgrep 的极速全文/正则搜索 | 查找关键常量、关键字引用及调用链 |
| | `glob` | 按文件名模式匹配查找文件 | 搜索特定类型的文件（如 `*.spec.ts`） |
| | `code_explore` | 代码符号与拓扑关系轻量探索 | 梳理大型仓库的代码组织结构 |
| ⚡ **命令终端** | `exec_command` | 执行命令（超时控制 + 长任务会话） | 运行 `npm test`、`git status`、编译构建 |
| | `write_stdin` | 向长时间运行的子进程标准输入写入 | 处理带有确认向导的命令行工具 |
| 🧭 **会话控制** | `project_control` | 查看、绑定、切换当前对话的目标项目 | 对话初期的项目锁定与安全隔离 |
| | `summary` | 本轮工具调用检查点自检总结 | 单轮任务完工前输出清晰结论 |
| 🔌 **能力扩展** | `skills_list` / `skill_read` | 发现并阅读本地已导入的 Skills | 执行预设的特定业务开发流 |
| | `mcp_tools` / `mcp_call` | 穿透调用下游已有扩展 MCP 工具 | 联动调用已配置的数据库/外部 API |

---

## 📋 常用命令速查

| 类别 | 命令 | 说明 |
| :--- | :--- | :--- |
| **服务启停** | `aimcp open` | 打开本机 Web 管理控制台（不启动 Runtime） |
| | `aimcp start` | 注册当前项目并启动/复用后台服务（默认复用上次模式） |
| | `aimcp start --local` | 显式以**纯本机模式**启动（无需域名和密码） |
| | `aimcp start --public` | 显式以**公网接入模式**启动（需先配置公网和密码） |
| | `aimcp status` | 查看运行状态、当前模式、本地/公网地址及已注册项目 |
| | `aimcp stop` | 停止 MCP Runtime 与公网隧道（Web 控制台继续在线） |
| | `aimcp restart` | 重启 MCP Runtime（代码更新或配置更改后执行） |
| | `aimcp shutdown` | 彻底关闭后台服务与 Web 控制台 |
| **项目管理** | `aimcp project list` | 查看所有已登记的项目列表 |
| | `aimcp project add [目录]` | 登记新项目目录（默认当前目录） |
| | `aimcp project remove [项目]` | 停用/注销指定项目（不删除代码文件） |
| | `aimcp bindings clean [项目]` | 清理指定项目的旧对话会话绑定记录 |
| **诊断配置** | `aimcp setup` | 首次配置或修改公网连接、域名与外部能力 |
| | `aimcp auth` | 重设/修改远程连接密码 |
| | `aimcp doctor` | 检查环境依赖、搜索组件及网络隧道健康状态 |
| | `aimcp doctor --fix` | 自动修复缺失组件、创建目录及异常状态 |
| | `aimcp logs [-f]` | 查看最新运行日志（`-f` 持续跟踪） |
| | `aimcp update` | 升级到最新发布版本 |

---

## 🧩 外部能力与 Skills 导入

`aimcp` 可以无缝复用你本地已有 AI 工具的配置与技能，无需重复拷贝：

```text
~/.gemini/settings.json ──┐
~/.codex/ ───────────────┼──► [aimcp 自动探测与引用] ──► 统一供给当前对话
~/.claude/ ──────────────┤
~/.agents/skills/ ───────┘
```

- **只读引用安全**：只读取并加载外部工具与 Skills 配置，绝不会将你的第三方 Token 与私有密钥写入公网或复制到 `~/.ai-mcp`。
- **动态热更新**：支持 `watch` 监听模式，当外部技能文件修改后，`aimcp` 会自动刷新能力清单。

---

## ❓ 故障排查与自愈决策树

遇到问题时，可按下面的决策树快速自愈：

```text
遇到连接或运行异常？
        │
        ▼
   执行 aimcp doctor
        │
        ├─► 报告“组件缺失” (如 ripgrep)？
        │     └─► 运行 aimcp doctor --fix 自动下载恢复
        │
        ├─► 客户端频繁“断开连接”或网络超时？
        │     ├─► 本机客户端 (Gemini CLI) ──► 优先用 aimcp start --local 回环直连
        │     ├─► 桌面端沙盒拦截 ──► 检查是否已将项目目录加入 Connected Folders
        │     └─► 代码刚更新 ──► 运行 aimcp restart 重启后台生效
        │
        ├─► 提示“密码错误或忘记密码”？
        │     └─► 运行 aimcp auth 重新设置连接密码
        │
        └─► 仍有未知报错？
              └─► 运行 aimcp logs -f 查看实时运行日志与报错堆栈
```

---

## 💻 本地开发

```bash
# 1. 克隆代码仓库
git clone https://github.com/rookieDJ/aimcp.git
cd aimcp

# 2. 安装依赖并构建
npm ci
npm run typecheck
npm run build

# 3. 本机快速启动调试
npm run start:local
```

---

## 🔒 安全说明

- **受限作用域**：`aimcp` 严格将文件读写与搜索限制在绑定的项目主目录内，避免越界访问系统其他文件。
- **公网强认证**：公网模式启用强密码鉴权与 OAuth 流程，切勿将公网接口地址和连接密码分享给他人。
- **执行权限警示**：终端执行命令继承当前系统操作用户的权限，请始终连接你信任的模型客户端与项目。

---

## 📄 License

[MIT](LICENSE)
