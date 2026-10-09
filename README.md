# aimcp

> 让 **ChatGPT**、**Google Gemini CLI** 或 **Gemini 网页端** 通过 MCP 协议，安全操作你电脑上的代码项目。

<p align="left">
  <img src="https://img.shields.io/badge/Node-%3E%3D22-brightgreen?logo=node.js&logoColor=white" alt="Node.js Version" />
  <img src="https://img.shields.io/badge/ChatGPT-Compatible-74aa9c?logo=openai&logoColor=white" alt="ChatGPT Compatible" />
  <img src="https://img.shields.io/badge/Gemini-Compatible-4285F4?logo=google&logoColor=white" alt="Gemini Compatible" />
  <img src="https://img.shields.io/badge/Protocol-MCP_Streamable_HTTP-blueviolet" alt="Protocol MCP" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License MIT" />
</p>

在日常开发对话中，你可以直接告诉 AI：

- 💬 *“帮我看看当前项目是做什么的”*
- 💬 *“检查一下 git 状态，现在有哪些未提交改动”*
- 💬 *“修掉这个报错，并跑一下单元测试”*
- 💬 *“把这个功能实现完，然后切到 api 项目继续”*

`aimcp` 会在你的电脑上受控地读取文件、修改代码、执行构建与测试命令，并把结果实时返回给 AI。

---

## 📌 目录

- [架构拓扑图](#-架构拓扑图)
- [模式选择指南](#-模式选择指南本机模式-vs-公网模式)
- [快速开始](#-快速开始)
  - [步骤 1：全局安装](#步骤-1全局安装)
  - [步骤 2：启动管理控制台](#步骤-2启动管理控制台推荐)
  - [步骤 3：接入 AI 客户端](#步骤-3接入-ai-客户端)
- [多项目隔离工作流](#-多项目隔离工作流)
- [精简 15 工具矩阵](#-精简-15-工具矩阵)
- [常用命令速查](#-常用命令速查)
- [外部能力导入 (Codex / Skills)](#-外部能力与-skills-导入)
- [故障排查与自愈决策树](#-故障排查与自愈决策树)
- [本地开发](#-本地开发)
- [安全说明](#-安全说明)

---

## 🗺️ 架构拓扑图

`aimcp` 将控制面与运行时彻底解耦。多个工程目录、多个对话窗口，统一由一个轻量级后台守护进程提供服务：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           🤖 AI 模型客户端                              │
│       Gemini CLI / Codex CLI              ChatGPT / Gemini 网页端       │
└────────────────────┬────────────────────────────────────┬───────────────┘
                     │ [纯本地 HTTP 直连]                  │ [安全 HTTPS 隧道]
                     ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     🌐 接入与认证层 (Ingress & Auth)                    │
│      127.0.0.1:3920/mcp (免密)              Cloudflare Tunnel + OAuth   │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    ⚙️ aimcp 后台服务 (Daemon Core)                      │
│   • Web Console 图形控制台              • 会话项目路由器 (Router)       │
│   • 运行状态诊断 (aimcp doctor)         • 15 个受控原子工具引擎         │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ 会话级严格路径锁定
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
      ┌─────────────┐         ┌─────────────┐         ┌─────────────┐
      │  前端工程 A  │         │  后端工程 B  │         │ 移动端工程 C │
      │ ~/code/web  │         │ ~/code/api  │         │ ~/code/app  │
      └─────────────┘         └─────────────┘         └─────────────┘
      ▲ 读写、搜索、测试命令严格限制在对应目录内，防止上下文串扰与路径越界 ▲
```

---

## 🧭 模式选择指南（本机模式 vs 公网模式）

无需纠结网络配置，根据你的客户端快速选择：

| 使用场景 | 推荐模式 | 网络与环境要求 | 是否需要密码 | 对应客户端 | 启动命令 |
| :--- | :---: | :---: | :---: | :--- | :--- |
| **同机开发 / 纯本地 CLI** | 🟢 **本机模式 (`--local`)** | 纯本地回环 (127.0.0.1)<br>无需公网 IP 与域名 | ❌ 免密访问 | Gemini CLI<br>Codex CLI | `aimcp start --local` |
| **云端网页端 / 手机 App** | 🟣 **公网模式 (`--public`)** | HTTPS 域名入口<br>(支持自动创建 Cloudflare Tunnel) | ✅ 强密码鉴权 + OAuth | ChatGPT 网页版<br>Gemini 网页版/App | `aimcp start --public` |

> [!TIP]
> 如果你在同一台电脑上使用 Gemini CLI，始终优先选择 **本机模式**，不仅无需设置任何公网域名与密码，而且完全免受外网网络抖动影响。

---

## 🚀 快速开始

### 步骤 1：全局安装

系统环境要求：**Node.js 22** 或更高版本。

```bash
npm install --global @rookiedj/aimcp
aimcp --version
```

---

### 步骤 2：启动管理控制台（推荐）

打开图形化 Web 控制台：

```bash
aimcp open
```

控制台将在本地浏览器打开（`http://127.0.0.1:3921`）：
1. **添加项目**：选择并登记你要操作的代码工程目录。
2. **选择启动模式**：根据需求点击“仅本机”或“公网接入”。
3. **获取连接**：启动后，一键复制当前生成的 MCP 服务地址。

> [!NOTE]
> `aimcp open` 启动的是纯本地控制面，**不会**自动触碰外网，也不会强制开启公网隧道。

---

### 步骤 3：接入 AI 客户端

<details open>
<summary><b>3.1 连接 Gemini CLI（本机模式，最推荐）</b></summary>
<br>

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

</details>

<details>
<summary><b>3.2 连接 Gemini 网页版 / 移动端（公网模式）</b></summary>
<br>

Google Gemini 网页端（`gemini.google.com`）运行在云端，需要一个安全的公网 HTTPS 入口：

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

**Spark 的两类授权提示**：

- 聊天里的 **Allow** 是 Gemini 对自定义 MCP 写操作的手动确认，项目绑定不等于允许后续所有修改。参见 [Google 官方说明](https://support.google.com/gemini/answer/17209137?hl=en-12)。aimcp 不能替客户端关闭确认，也不会将写操作标成只读。
- aimcp 登录页要求连接密码属于 **OAuth 授权**。切换项目不会撤销令牌；访问令牌有效期为 15 分钟，客户端应使用刷新令牌续期。刷新请求未带 `resource` 时仍严格绑定当前 MCP 地址；换地址、修改连接密码、撤销授权或刷新令牌重放会导致授权失效。反复出现 401 时，在 `aimcp doctor` 中查看令牌交换/续期阶段与错误类别，无需发送密码或令牌。
- 临时断网、DNS 故障、客户端元数据或公钥服务暂时不可用时，令牌端点返回可重试的 `503 server_error` 和 `Retry-After`，保留已有授权。请求在令牌交换开始前断开也不会消耗令牌。若刷新已经提交，但响应在网络中丢失，再使用旧刷新令牌仍会触发重放保护；此时可能需要重新连接，服务端不能保证客户端自动恢复。

</details>

<details>
<summary><b>3.3 连接 ChatGPT（公网模式）</b></summary>
<br>

1. 确保以公网模式运行：`aimcp start --public`。
2. 在 ChatGPT 账号设置中启用 **Developer Mode**（开发者模式）。
3. 进入 **Apps → Create**，填入你的公网 MCP 地址（如 `https://aimcp.your-domain.com/mcp`）。
4. 点击扫描工具（Scan Tools），按提示输入之前生成的连接密码完成 OAuth 验证并保存。

</details>

<details>
<summary><b>3.4 连接 Codex CLI（本机模式）</b></summary>
<br>

```bash
aimcp start --local
codex mcp add aimcp --url http://127.0.0.1:3920/mcp
codex mcp list
```

</details>

---

## 🗂️ 多项目隔离工作流

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
```

### 项目操作口令：

1. **登记项目**：进入不同目录分别执行 `aimcp start`，或执行 `aimcp project add /path/to/project`。
2. **对话内选择**：初次对话时 AI 会调用 `project_control` 询问要操作哪个工程，你只需说：*“使用 web 项目”*。
3. **中途切换**：直接说：*“切换到 api 项目继续”*，AI 即可平滑换绑上下文。

---

## 上下文压缩与摘要恢复

### Gemini CLI 原生压缩

Gemini CLI 原生支持自动上下文压缩，默认 `model.compressionThreshold=0.5`。在本机控制台的 **系统 → 上下文与摘要** 设置触发比例；保存只修改 `~/.gemini/settings.json` 的该字段，保留其他配置和 JSONC 注释，**重启 Gemini CLI 后加载**。项目和系统设置可能覆盖用户设置，因此面板显示的是用户级阈值，不代表所有正在运行的 CLI 都已采用它。配置被外部修改时会拒绝覆盖，需重新读取。

在 Gemini CLI 聊天中可输入 `/compress` 手动压缩；这是 CLI 命令，不能作为 shell 或 MCP 工具执行。自动压缩由 CLI 判断真实上下文用量并调用模型完成。参见 [Gemini CLI 配置](https://geminicli.com/docs/reference/configuration/)。

### Gemini App / ChatGPT 摘要检查点

目前未找到 Gemini App 提供的、可由 MCP 调用的上下文压缩接口。aimcp 提供客户端主动发送的任务摘要检查点，**不清空 App 的上下文，也不保证客户端会遵循提醒**。

1. 在 **项目 → 本地会话记录** 开启保存（默认关闭）。关闭时不新增摘要，MCP 也不读取已保存的检查点；重新开启不补录关闭期间内容。
2. 保留 `project_control(select)` 返回的 `project_session`。后续成功的工具结果也会附上当前项目和句柄，避免只依赖聊天最开始的绑定消息；绑定与本地聊天保存开关独立。整理上下文时保留句柄，恢复时先调用 `project_control(action=current)` 核对项目。连续 20 次成功的非 `project_control` 调用，或累计约 64 KB MCP 结果，会提醒客户端保存。统计只在内存中保留，**不是模型 token 用量**。
3. 客户端生成精简摘要（任务目标、约束、关键决定、改动与验证结果、下一步），调用：

   ```json
   {
     "action": "checkpoint",
     "project_session": "当前会话的句柄",
     "purpose": "保存任务摘要",
     "checkpoint": {
       "id": "checkpoint-1",
       "previous_id": null,
       "summary": "已完成的工作和必须保留的任务状态",
       "next_steps": ["核对当前文件后继续未完成工作"]
     }
   }
   ```

4. 重连或上下文丢失后，携带同一会话的句柄调用 `project_control(action=restore)`。只读取**当前会话、当前项目**的最新检查点；不会自动授权、恢复绑定或读取其他聊天。更新时使用新 `id` 和上一份的 `previous_id`，防止旧请求覆盖新摘要。失效句柄需重新选择用户确认的项目，不能借用其他会话。
5. **本地会话详情**可查看摘要，也可手动复制给新的聊天。摘要按历史任务数据处理，恢复后重新核对文件、权限和状态；不包含隐藏推理、系统提示、密码或密钥。

如果 Gemini 遗忘了句柄，先从**当前聊天近期工具结果**找回；如果句柄和稳定的聊天标识都丢失，需要用户确认项目后重新选择。新绑定可以继续操作代码，但不会自动继承旧聊天的摘要；可由用户在本地详情中查看并提供原摘要。服务端不会仅凭同一账号、只有一个项目或“最近使用”来猜测绑定，也不能保证 Gemini 的上下文压缩保留所有工具结果。

检查点与聊天记录共用 `~/.ai-mcp/conversations/` 私有文件（POSIX 权限 `0600`），按会话、客户端、项目隔离；每项目只保留最新摘要，最多 8,000 字符、32 KB，最多 8 条下一步。删除会话记录会同时删除摘要。内容由客户端提供，可能包含项目隐私，以明文保存；npm 包不会包含本机记录。

客户端未提供标题时，会话列表显示“客户端 · 首次使用项目 · 会话短编号”，不会从聊天内容提取名称。开启本地保存后，客户端可在 `select`、`record` 或 `checkpoint` 时提供简短的 `title`；也可在本地列表中重命名，手动名称优先保留。这不会修改 Gemini / ChatGPT 聊天窗口的标题，也不能自动读取其原始标题。

## 🛠️ 精简 15 工具矩阵

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
| 🧭 **会话控制** | `project_control` | 项目绑定、聊天保存、摘要检查点与恢复 | 项目隔离与长任务续接 |
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
~/.codex/ ───────────────┼──► [aimcp 自动探测与只读加载] ──► 统一供给当前对话
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

> [!IMPORTANT]
> - **受限作用域**：`aimcp` 严格将文件读写与搜索限制在绑定的项目主目录内，避免越界访问系统其他文件。
> - **公网强认证**：公网模式启用强密码鉴权与 OAuth 流程，切勿将公网接口地址和连接密码分享给他人。
> - **执行权限警示**：终端执行命令继承当前系统操作用户的权限，请始终连接你信任的模型客户端与项目。

---

## 📄 License

[MIT](LICENSE)
