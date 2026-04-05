import { MessageCircleIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

const WORKSPACE_MODES: ReadonlyArray<{
  value: ThreadWorkspaceMode;
  label: string;
  Icon: typeof MessageCircleIcon;
}> = [
  { value: "chat", label: "Chat", Icon: MessageCircleIcon },
  { value: "editor", label: "Editor", Icon: SquarePenIcon },
];

export const WorkspaceModeToggle = memo(function WorkspaceModeToggle(props: {
  mode: ThreadWorkspaceMode;
  onModeChange: (mode: ThreadWorkspaceMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Switch workspace mode"
      className="relative flex items-center rounded-full border border-border/70 bg-background/92 p-[3px] shadow-xs/5 supports-[backdrop-filter]:bg-background/78 supports-[backdrop-filter]:backdrop-blur-md"
    >
      {/* Animated sliding pill */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-[3px] w-[calc(50%-1.5px)] rounded-full bg-primary/12 shadow-sm transition-[left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]",
          props.mode === "chat" ? "left-[3px]" : "left-[calc(50%+1.5px)]",
        )}
      />
      {WORKSPACE_MODES.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={props.mode === value}
                aria-label={label}
                className={cn(
                  "relative z-10 flex size-[26px] items-center justify-center rounded-full transition-colors duration-150",
                  props.mode === value
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  if (value !== props.mode) {
                    props.onModeChange(value);
                  }
                }}
              >
                <Icon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="bottom">{label}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
});
