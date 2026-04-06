import { memo } from "react";
import { BotIcon, ChevronDownIcon, ChevronLeftIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  canQueueMessage: boolean;
  onPreviousPendingQuestion: () => void;
  onQueueMessage: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  return input.isLastQuestion ? "Submit answers" : "Next question";
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isPreparingWorktree,
  hasSendableContent,
  canQueueMessage,
  onPreviousPendingQuestion,
  onQueueMessage,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full border-border/50 shadow-xs"
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-border/50 shadow-xs"
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full shadow-sm shadow-primary/15", compact ? "px-3" : "px-4")}
          disabled={
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning || (isSendBusy && canQueueMessage)) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {canQueueMessage ? (
          <Button
            type="button"
            size={isRunning ? "icon-xs" : "sm"}
            variant="ghost"
            className={cn(
              "rounded-full transition-all duration-150",
              isRunning
                ? "bg-primary/8 text-primary shadow-sm shadow-primary/8 hover:bg-primary/14 hover:text-primary hover:shadow-primary/15"
                : compact
                  ? "px-3"
                  : "px-4",
            )}
            onClick={onQueueMessage}
            disabled={isConnecting}
            aria-label={isRunning ? "Steer message" : "Queue message"}
            title={isRunning ? "Steer message" : "Queue message"}
          >
            {isRunning ? <BotIcon className="size-3.5" /> : "Queue"}
          </Button>
        ) : null}

        {isRunning ? (
          <button
            type="button"
            className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white shadow-md shadow-rose-500/25 transition-all duration-200 hover:bg-rose-500 hover:shadow-lg hover:shadow-rose-500/30 sm:size-7"
            onClick={onInterrupt}
            aria-label="Stop generation"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <div
            className="flex size-7 items-center justify-center rounded-full border border-border/40 bg-card/50 text-muted-foreground/50 sm:size-7"
            aria-label="Sending current message"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              className="animate-spin"
              aria-hidden="true"
            >
              <circle
                cx="6"
                cy="6"
                r="4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray="16 10"
              />
            </svg>
          </div>
        )}
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn(
            "rounded-full shadow-sm shadow-primary/15",
            compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8",
          )}
          disabled={isSendBusy || isConnecting}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className={cn(
            "h-9 rounded-l-full rounded-r-none shadow-sm shadow-primary/15 sm:h-8",
            compact ? "px-3" : "px-4",
          )}
          disabled={isSendBusy || isConnecting}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/10 px-2 shadow-sm shadow-primary/15 sm:h-8"
                aria-label="Implementation actions"
                disabled={isSendBusy || isConnecting}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className="flex h-8 w-8 enabled:cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md shadow-primary/20 transition-all duration-200 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 disabled:pointer-events-none disabled:opacity-20 disabled:shadow-none disabled:hover:scale-100 sm:h-7 sm:w-7"
      disabled={isSendBusy || isConnecting || !hasSendableContent}
      aria-label={
        isConnecting
          ? "Connecting"
          : isPreparingWorktree
            ? "Preparing worktree"
            : isSendBusy
              ? "Sending"
              : "Send message"
      }
    >
      {isConnecting || isSendBusy ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="animate-spin"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="20 12"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
});
