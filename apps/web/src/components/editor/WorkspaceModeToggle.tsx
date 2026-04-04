import { memo } from "react";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

export const WorkspaceModeToggle = memo(function WorkspaceModeToggle(props: {
  mode: ThreadWorkspaceMode;
  onModeChange: (mode: ThreadWorkspaceMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Switch workspace mode"
      className="rounded-xl border border-border/70 bg-background/80 p-1 shadow-xs/5 backdrop-blur"
      value={[props.mode]}
      onValueChange={(value) => {
        const nextMode = value[0];
        if ((nextMode === "chat" || nextMode === "editor") && nextMode !== props.mode) {
          props.onModeChange(nextMode);
        }
      }}
    >
      <ToggleGroupItem
        value="chat"
        variant="outline"
        size="xs"
        className="min-w-16 rounded-lg border-transparent px-3 text-[11px] tracking-[0.18em] uppercase data-[pressed]:border-border/70 data-[pressed]:bg-card"
      >
        Chat
      </ToggleGroupItem>
      <ToggleGroupItem
        value="editor"
        variant="outline"
        size="xs"
        className="min-w-16 rounded-lg border-transparent px-3 text-[11px] tracking-[0.18em] uppercase data-[pressed]:border-border/70 data-[pressed]:bg-card"
      >
        Editor
      </ToggleGroupItem>
    </ToggleGroup>
  );
});
