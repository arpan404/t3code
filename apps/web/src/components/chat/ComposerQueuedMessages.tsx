import { BotIcon, ImageIcon, PencilLineIcon, TerminalSquareIcon, Trash2Icon } from "lucide-react";
import { PROVIDER_DISPLAY_NAMES, type MessageId, type ModelSelection } from "@t3tools/contracts";

import { formatQueuedComposerMessagePreview } from "../../lib/chat/chatView";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ComposerQueuedMessageItem {
  id: MessageId;
  prompt: string;
  images: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<{ id: string }>;
  modelSelection: ModelSelection;
}

export function ComposerQueuedMessages(props: {
  messages: ReadonlyArray<ComposerQueuedMessageItem>;
  className?: string;
  steerMessageId?: MessageId | null;
  onEdit: (messageId: MessageId) => void;
  onDelete: (messageId: MessageId) => void;
  onSteer: (messageId: MessageId) => void;
}) {
  if (props.messages.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "mb-3 overflow-hidden rounded-t-[19px] border border-border/65 bg-muted/20",
        props.className,
      )}
    >
      <div className="px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            Queue
          </span>
          {props.messages.length > 1 ? (
            <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
              {props.messages.length}
            </span>
          ) : null}
        </div>

        <div className="mt-2.5 max-h-44 space-y-1 overflow-y-auto pr-1">
          {props.messages.map((message, index) => {
            const preview = formatQueuedComposerMessagePreview({
              prompt: message.prompt,
              imageCount: message.images.length,
              terminalContextCount: message.terminalContexts.length,
            });
            const isSteered = props.steerMessageId === message.id;

            return (
              <div
                key={message.id}
                className={cn(
                  "group rounded-lg border px-3 py-2 transition-all duration-150",
                  isSteered
                    ? "border-primary/35 bg-primary/8 text-foreground"
                    : "border-transparent bg-muted/20 text-foreground/80 hover:border-border/40 hover:bg-muted/40",
                )}
              >
                <div className="flex items-start gap-3">
                  <kbd
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                      isSteered
                        ? "bg-primary/15 text-primary"
                        : "bg-muted/40 text-muted-foreground/50 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                    )}
                  >
                    {index + 1}
                  </kbd>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/80">
                      <span>{PROVIDER_DISPLAY_NAMES[message.modelSelection.provider]}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{message.modelSelection.model}</span>
                    </div>

                    <div className="mt-1 text-sm text-foreground/90">{preview}</div>

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground/75">
                      {message.images.length > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <ImageIcon className="size-3.5" />
                          {message.images.length}
                        </span>
                      ) : null}
                      {message.terminalContexts.length > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <TerminalSquareIcon className="size-3.5" />
                          {message.terminalContexts.length}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-1 pl-8">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className={cn(
                      "rounded-full",
                      isSteered
                        ? "bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary"
                        : "text-muted-foreground/80 hover:text-primary",
                    )}
                    onClick={() => props.onSteer(message.id)}
                    aria-label={isSteered ? "Steering queued message" : "Steer queued message"}
                    title={isSteered ? "Steering queued message" : "Steer queued message"}
                  >
                    <BotIcon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="rounded-full text-muted-foreground/80 hover:text-foreground"
                    onClick={() => props.onEdit(message.id)}
                    aria-label="Edit queued message"
                    title="Edit queued message"
                  >
                    <PencilLineIcon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="rounded-full text-muted-foreground/80 hover:text-foreground"
                    onClick={() => props.onDelete(message.id)}
                    aria-label="Delete queued message"
                    title="Delete queued message"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
