import {
  type EditorId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@ace/contracts";
import { memo, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import { BugIcon, DiffIcon, GlobeIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";
import { WorkspaceModeToggle } from "../editor/WorkspaceModeToggle";
import { TopBarCluster, interleaveTopBarItems } from "../thread/TopBarCluster";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectId: ProjectId | null;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  browserToggleShortcutLabel: string | null;
  browserAvailable: boolean;
  browserOpen: boolean;
  browserDevToolsOpen: boolean;
  gitCwd: string | null;
  diffOpen: boolean;
  workspaceMode: ThreadWorkspaceMode;
  workspaceName: string | undefined;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onOpenBrowser: () => void;
  onCloseBrowser: () => void;
  onActiveProjectChange?: ((projectId: ProjectId) => void) | null;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onWorkspaceModeChange: (mode: ThreadWorkspaceMode) => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectId,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  browserToggleShortcutLabel,
  browserAvailable,
  browserOpen,
  browserDevToolsOpen,
  gitCwd,
  diffOpen,
  workspaceMode,
  workspaceName,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onOpenBrowser,
  onCloseBrowser,
  onActiveProjectChange,
  onToggleTerminal,
  onToggleDiff,
  onWorkspaceModeChange,
}: ChatHeaderProps) {
  const workspaceActionItems: ReactNode[] = [
    activeProjectScripts ? (
      <ProjectScriptsControl
        key="scripts"
        scripts={activeProjectScripts}
        keybindings={keybindings}
        preferredScriptId={preferredScriptId}
        onRunScript={onRunProjectScript}
        onAddScript={onAddProjectScript}
        onUpdateScript={onUpdateProjectScript}
        onDeleteScript={onDeleteProjectScript}
      />
    ) : null,
    activeProjectName ? (
      <OpenInPicker
        key="open-in"
        keybindings={keybindings}
        availableEditors={availableEditors}
        openInCwd={openInCwd}
      />
    ) : null,
    activeProjectName ? (
      <GitActionsControl key="git" gitCwd={gitCwd} activeThreadId={activeThreadId} />
    ) : null,
  ];
  const workspaceActionNodes = interleaveTopBarItems(workspaceActionItems);
  const utilityItems = interleaveTopBarItems([
    browserAvailable ? (
      <Tooltip key="browser">
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0 rounded-lg"
              pressed={browserOpen}
              onPressedChange={(pressed) => {
                if (!pressed) {
                  onCloseBrowser();
                }
              }}
              onDoubleClick={onOpenBrowser}
              aria-label={browserOpen ? "Close in-app browser" : "Open in-app browser"}
              variant="default"
              size="xs"
            >
              <span className="relative flex items-center justify-center">
                <GlobeIcon className="size-3" />
                {browserOpen && browserDevToolsOpen ? (
                  <span className="absolute -top-1 -right-1 flex size-2.5 items-center justify-center rounded-full border border-background bg-amber-500 text-amber-950">
                    <BugIcon className="size-1.5" />
                  </span>
                ) : null}
              </span>
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {browserOpen
            ? browserToggleShortcutLabel
              ? `${browserDevToolsOpen ? "Close in-app browser · DevTools open" : "Close in-app browser"} (${browserToggleShortcutLabel})`
              : browserDevToolsOpen
                ? "Close in-app browser · DevTools open"
                : "Close in-app browser"
            : browserToggleShortcutLabel
              ? `Double-click to open in-app browser (${browserToggleShortcutLabel})`
              : "Double-click to open in-app browser"}
        </TooltipPopup>
      </Tooltip>
    ) : null,
    <Tooltip key="terminal">
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 rounded-lg"
            pressed={terminalOpen}
            onPressedChange={onToggleTerminal}
            aria-label="Toggle terminal drawer"
            variant="default"
            size="xs"
            disabled={!terminalAvailable}
          >
            <TerminalSquareIcon className="size-3" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!terminalAvailable
          ? "Terminal is unavailable until this thread has an active project."
          : terminalToggleShortcutLabel
            ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
            : "Toggle terminal drawer"}
      </TooltipPopup>
    </Tooltip>,
    <Tooltip key="diff">
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 rounded-lg"
            pressed={diffOpen}
            onPressedChange={onToggleDiff}
            aria-label="Toggle diff panel"
            variant="default"
            size="xs"
            disabled={!isGitRepo}
          >
            <DiffIcon className="size-3" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!isGitRepo
          ? "Diff panel is unavailable because this project is not a git repository."
          : diffToggleShortcutLabel
            ? `Toggle diff panel (${diffToggleShortcutLabel})`
            : "Toggle diff panel"}
      </TooltipPopup>
    </Tooltip>,
  ]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        {workspaceMode === "editor" ? (
          <span
            className="min-w-0 truncate text-[13px] leading-none font-medium tracking-tight text-foreground/80"
            title={workspaceName ?? activeProjectName}
          >
            {workspaceName ?? activeProjectName ?? "Workspace"}
          </span>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <h2
              className="min-w-0 shrink truncate text-[13px] leading-none font-medium tracking-tight text-foreground/80"
              title={activeThreadTitle}
            >
              {activeThreadTitle}
            </h2>
            {activeProjectName && (
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {activeProjectId !== null && onActiveProjectChange ? (
                  <ProjectContextSwitcher
                    activeProjectId={activeProjectId}
                    className="min-w-0 max-w-52 shrink"
                    onSelectProject={onActiveProjectChange}
                  />
                ) : (
                  <Badge
                    variant="outline"
                    size="sm"
                    className="min-w-0 max-w-48 shrink overflow-hidden border-border/30 bg-muted/30 text-muted-foreground/60"
                  >
                    <span className="min-w-0 truncate">{activeProjectName}</span>
                  </Badge>
                )}
                {!isGitRepo && (
                  <Badge variant="warning" size="sm" className="shrink-0">
                    No Git
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <WorkspaceModeToggle mode={workspaceMode} onModeChange={onWorkspaceModeChange} />
        {workspaceActionNodes.length > 0 ? (
          <TopBarCluster>{workspaceActionNodes}</TopBarCluster>
        ) : null}
        <TopBarCluster>{utilityItems}</TopBarCluster>
      </div>
    </div>
  );
});
