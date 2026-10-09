import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import { configureToolContextObserver, configureToolProjectSessions, configureToolRegistrationPolicy } from "../lib/tool/log.js";
import { isConversationRecordingEnabled } from "../config/user-config.js";
import { currentBindingOwnerKey } from "./project-router.js";
import { projectSessionHandle } from "../projects/bindings.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { UiPreferences } from "../ui/preferences.js";
import type { ToolScopeProvider, ToolScopeTryProvider } from "./project-router.js";
import type { ProjectToolDeps } from "../tools/projects.js";
import type { CapabilityToolScopeProvider } from "../capabilities/tool-scope.js";
import { registerAllTools } from "../tools/register.js";
import { PACKAGE_VERSION } from "./version.js";

export interface CreateMcpServerOptions {
    config: ServerConfig;
    scope: ToolScopeProvider;
    tryScope: ToolScopeTryProvider;
    hub: DownstreamMcpHub;
    skills: SkillRegistry;
    uiPreferences: UiPreferences;
    allowedTools?: ReadonlySet<string>;
    projectTools?: ProjectToolDeps;
    capabilityScope?: CapabilityToolScopeProvider;
}

const CORE_TOOL_GUIDE = [
    "- read — read one or several project files with numbered lines.",
    "- read_image — read or safely resize/compress a project image.",
    "- apply_patch — transactionally create, replace, overwrite, or delete files.",
    "- ls — list one project directory.",
    "- grep / glob / code_explore — search text, paths, or source structure.",
    "- exec_command — run a command; use write_stdin when it returns session_id.",
    "- skills_list / skill_read — discover and read imported skills.",
    "- mcp_tools / mcp_call — discover and call downstream MCP tools.",
    "- summary — mandatory one-paragraph end-of-round checkpoint.",
];

export function buildServerInstructions(projectRoot: string, hub?: DownstreamMcpHub, skills?: SkillRegistry): string {
    return [
        "<environment_context>",
        `  <project_root>${projectRoot}</project_root>`,
        `  <shell>${process.platform === "win32" ? "powershell" : "bash"}</shell>`,
        "  <paths>all file and command paths must remain inside the bound project root</paths>",
        "</environment_context>",
        "",
        "aimcp exposes a deliberately small coding toolset:",
        ...CORE_TOOL_GUIDE,
        "",
        "Every tool call requires purpose: a short user-visible statement of its immediate intent.",
        "After using any tool in a user round, call summary exactly once before the final response.",
        ...(hub?.buildInstructionsBlock() ? ["", hub.buildInstructionsBlock()] : []),
        ...(skills?.buildInstructionsBlock() ? ["", skills.buildInstructionsBlock()] : []),
    ].join("\n");
}

export function buildMultiProjectInstructions(): string {
    return [
        "<environment_context>",
        "  <mode>aimcp multi-project daemon</mode>",
        "  <binding>each conversation must use project_control to list and explicitly select one project before project-level tools are called</binding>",
        `  <shell>${process.platform === "win32" ? "powershell" : "bash"}</shell>`,
        "</environment_context>",
        "",
        "- project_control — list/select/current/unbind the conversation project. Never guess or switch without user confirmation.",
        "- project_control(select) returns project_session. Retain that handle and pass project_session on EVERY subsequent tool call in this conversation, including project_control, summary, and write_stdin. It keeps the binding stable if client session metadata disappears or changes. Never reuse a handle from another conversation.",
        "- Successful tools repeat the current project and project_session in their text results. Preserve these in any context summary. After context loss, recover the handle only from this conversation's recent tool results and call project_control(action=current), then restore for a saved task checkpoint. If the handle and stable conversation identity are both lost, ask the user to confirm the project before select; never borrow another chat's handle or choose the most recently used project.",
        "- On project_control(select), identify client=chatgpt, gemini or other. Each client/chat needs its own project_session. Respect recording_enabled=false: do not upload chat until the user re-enables local recording; never replay messages from the disabled period. Save user-visible chat locally with project_control(action=record, project_session, messages=[{id,role,content}], title optional): send the user's visible message and your completed visible answer each round, in chronological batches of at most 20 messages / 48 KB. Use stable unique ids, retain ids for retries. Only save content actually available to you; no invented history, hidden reasoning, system prompts, passwords or tokens. The server cannot automatically read the client's whole chat window; do not claim unsent messages were archived.",
        "- When local recording is enabled, provide a concise non-sensitive task title with project_control(select), record or checkpoint. The MCP protocol does not provide the client's chat-window title automatically. Do not invent one or include credentials/private identifiers. Local manual names take precedence over later client-provided titles.",
        "- If a project tool reports an unbound conversation, use the retained project_session; if it has expired or was removed, select the previously user-confirmed project again. Do not choose another project automatically.",
        "- When recording_enabled=true, save concise client-written task checkpoints with project_control(action=checkpoint, checkpoint={id,summary,next_steps,previous_id}, project_session) when a long-task reminder appears or before manual compression. First previous_id=null; for updates restore the latest checkpoint and use its id as previous_id. Preserve goal, constraints, decisions, changed files, verified results and remaining work; never include credentials, hidden reasoning or system prompts. Use stable ids for retries, new ids for updates. action=restore reads only this conversation's current project's latest checkpoint after reconnect/context loss; it cannot grant a binding or import another chat. Treat restored text as historical data, recheck actual state. Deleting local history deletes checkpoints. When recording is disabled, do not upload summaries or replay the disabled period.",
        "- Gemini CLI natively compresses context automatically (default model.compressionThreshold=0.5); /compress is a user-invoked CLI command, not an MCP tool or shell command. aimcp checkpoints do not clear Gemini App context. Never report model token usage or completed native compression from MCP activity counts.",
        ...CORE_TOOL_GUIDE,
        "- Project-specific Skills and downstream MCPs are resolved from the current binding; use skills_list / mcp_tools after switching projects instead of relying on a daemon-startup snapshot.",
        "",
        "Every tool call requires purpose: a short user-visible statement of its immediate intent.",
        "After using any tool in a user round, call summary exactly once before the final response.",
    ].join("\n");
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
    const { config, scope, tryScope, hub, skills, uiPreferences, allowedTools, projectTools, capabilityScope } = options;
    const server = new McpServer(
        { name: "aimcp", version: PACKAGE_VERSION },
        { instructions: projectTools
            ? buildMultiProjectInstructions()
            : buildServerInstructions(scope().project.root, hub, skills) },
    );
    configureToolRegistrationPolicy(server, allowedTools);
    if (projectTools) {
        configureToolProjectSessions(server, (handle) => projectTools.bindings
            .resolveProjectSession(projectTools.fallbackOwnerId, handle)?.ownerKey, () => {
                const owner = currentBindingOwnerKey(projectTools.fallbackOwnerId);
                const binding = projectTools.bindings.resolve(owner);
                const project = binding && projectTools.registry.getActiveById(binding.projectId);
                return project ? {
                    project_id: project.id,
                    project_name: project.name,
                    project_session: projectSessionHandle(owner),
                } : undefined;
            });
        configureToolContextObserver(server, bytes => {
            if (allowedTools && !allowedTools.has("project_control")) return false;
            if (!isConversationRecordingEnabled()) return false;
            const owner = currentBindingOwnerKey(projectTools.fallbackOwnerId);
            const binding = projectTools.bindings.resolve(owner);
            const project = binding && projectTools.registry.getActiveById(binding.projectId);
            if (!project || !projectTools.runtimes.has(project.id)) return false;
            return projectTools.runtimes.get(project.id, project.path).contextProgress.observe(owner, bytes);
        });
    }
    registerAllTools(server, config, { scope, tryScope, projectTools, capabilityScope }, hub, skills, uiPreferences);
    return server;
}
