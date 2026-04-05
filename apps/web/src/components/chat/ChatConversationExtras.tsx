import type { ComponentProps } from "react";

import BranchToolbar from "../BranchToolbar";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";

export function ChatConversationExtras({
  branchToolbarProps,
  pullRequestDialogKey,
  pullRequestDialogProps,
}: {
  branchToolbarProps: ComponentProps<typeof BranchToolbar> | null;
  pullRequestDialogKey: string | number | null;
  pullRequestDialogProps: ComponentProps<typeof PullRequestThreadDialog> | null;
}) {
  return (
    <>
      {branchToolbarProps ? <BranchToolbar {...branchToolbarProps} /> : null}
      {pullRequestDialogProps ? (
        <PullRequestThreadDialog
          key={pullRequestDialogKey ?? undefined}
          {...pullRequestDialogProps}
        />
      ) : null}
    </>
  );
}
