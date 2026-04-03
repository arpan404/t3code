export interface SequencedTimelineItem {
  createdAt: string;
  sequence?: number | undefined;
}

export function compareSequenceThenCreatedAt(
  left: SequencedTimelineItem,
  right: SequencedTimelineItem,
): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence - right.sequence;
  }

  return left.createdAt.localeCompare(right.createdAt);
}

export function compareActivityLifecycleRank(kind: string | undefined): number {
  if (!kind) {
    return 1;
  }
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}
