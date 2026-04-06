import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderSession,
  RuntimeContentStreamKind,
  RuntimeItemStatus,
} from "@t3tools/contracts";

import {
  asObject,
  asReadonlyArray as asArray,
  asTrimmedNonEmptyString as asString,
} from "../unknown.ts";

import type {
  CursorPermissionOption,
  CursorPermissionOptionKind,
} from "./CursorAdapterSessionMetadata.ts";

export function extractCursorStreamText(
  update: Record<string, unknown> | undefined,
): string | undefined {
  const content = asObject(update?.content);
  return asStreamText(content?.text) ?? asStreamText(update?.text);
}

function asStreamText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripWrappingBackticks(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("`") && trimmed.endsWith("`") ? trimmed.slice(1, -1).trim() : trimmed;
}

function looksLikeShellCommand(value: string): boolean {
  const normalized = stripWrappingBackticks(value);
  return (
    normalized.includes(" ") ||
    normalized.includes("/") ||
    normalized.includes("&&") ||
    normalized.includes("||") ||
    normalized.includes("|") ||
    normalized.includes("$") ||
    normalized.includes("=")
  );
}

export function defaultCursorToolTitle(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Terminal";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image";
    case "collab_agent_tool_call":
      return "Subagent task";
    default:
      return "Tool call";
  }
}

export function classifyCursorToolItemType(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly subagentType?: string | undefined;
}): CanonicalItemType {
  const normalized = [input.kind, input.title, input.subagentType]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  if (
    normalized.includes("subagent") ||
    normalized.includes("sub-agent") ||
    normalized.includes("agent") ||
    normalized.includes("explore") ||
    normalized.includes("browser_use") ||
    normalized.includes("browser use") ||
    normalized.includes("computer_use") ||
    normalized.includes("computer use") ||
    normalized.includes("video_review") ||
    normalized.includes("video review") ||
    normalized.includes("vm_setup_helper") ||
    normalized.includes("vm setup helper")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("execute") ||
    normalized.includes("terminal") ||
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("search") ||
    normalized.includes("url") ||
    normalized.includes("browser")
  ) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyCursorTool(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
}): boolean {
  const normalized = [input.kind, input.title]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  return (
    normalized.includes("read") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function requestTypeForCursorTool(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
}): CanonicalRequestType {
  if (isReadOnlyCursorTool(input)) {
    return "file_read_approval";
  }
  const itemType = classifyCursorToolItemType(input);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function runtimeItemStatusFromCursorStatus(status: string | undefined): RuntimeItemStatus {
  switch (status?.toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "rejected":
    case "declined":
      return "declined";
    default:
      return "inProgress";
  }
}

export function isFinalCursorToolStatus(status: RuntimeItemStatus): boolean {
  return status !== "inProgress";
}

export function cursorToolLookupInput(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly subagentType?: string | undefined;
}) {
  return {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.subagentType ? { subagentType: input.subagentType } : {}),
  };
}

export function extractCursorToolContentText(
  record: Record<string, unknown> | undefined,
): string | undefined {
  const content = asArray(record?.content);
  if (!content) {
    return undefined;
  }
  for (const entry of content) {
    const contentRecord = asObject(entry);
    const nested = asObject(contentRecord?.content);
    const text = asString(nested?.text) ?? asString(contentRecord?.text);
    if (text) {
      return stripWrappingBackticks(text);
    }
  }
  return undefined;
}

export function extractCursorToolCommand(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  for (const candidate of [
    asString(record.command),
    asString(rawInput?.command),
    asString(rawInput?.cmd),
    asString(rawOutput?.command),
  ]) {
    if (candidate) {
      return stripWrappingBackticks(candidate);
    }
  }
  const title = asString(record.title);
  const kind = asString(record.kind);
  if (title && ((kind && kind.toLowerCase().includes("execute")) || looksLikeShellCommand(title))) {
    return stripWrappingBackticks(title);
  }
  return undefined;
}

export function extractCursorToolPath(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  for (const candidate of [
    asString(record.filePath),
    asString(record.path),
    asString(record.relativePath),
    asString(rawInput?.filePath),
    asString(rawInput?.path),
    asString(rawOutput?.filePath),
    asString(rawOutput?.path),
  ]) {
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function resolveCursorToolTitle(
  itemType: CanonicalItemType,
  rawTitle: string | undefined,
  previousTitle?: string,
): string {
  const titleCandidate = rawTitle ? stripWrappingBackticks(rawTitle) : undefined;
  if (titleCandidate && !looksLikeShellCommand(titleCandidate)) {
    return titleCandidate;
  }
  return previousTitle ?? defaultCursorToolTitle(itemType);
}

export function buildCursorToolData(
  existingData: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  const command = extractCursorToolCommand(record);
  const path = extractCursorToolPath(record);
  const previousItem = asObject(existingData?.item);
  return {
    ...existingData,
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(rawInput ? { input: rawInput } : {}),
    ...(rawOutput ? { result: rawOutput } : {}),
    item: {
      ...previousItem,
      ...(asString(record.title)
        ? { title: stripWrappingBackticks(asString(record.title) ?? "") }
        : {}),
      ...(asString(record.kind) ? { kind: asString(record.kind) } : {}),
      ...(asString(record.status) ? { status: asString(record.status) } : {}),
      ...(asString(record.toolCallId) ? { toolCallId: asString(record.toolCallId) } : {}),
      ...(command ? { command } : {}),
      ...(path ? { path } : {}),
      ...(rawInput ? { input: rawInput } : {}),
      ...(rawOutput ? { result: rawOutput } : {}),
    },
  };
}

export function describePermissionRequest(params: unknown): string | undefined {
  const record = asObject(params);
  if (!record) {
    return undefined;
  }

  const toolCall = asObject(record.toolCall);
  if (toolCall) {
    const itemType = classifyCursorToolItemType(
      cursorToolLookupInput({
        kind: asString(toolCall.kind),
        title: asString(toolCall.title),
      }),
    );
    const detail = extractCursorToolCommand(toolCall) ?? extractCursorToolPath(toolCall);
    if (detail) {
      return detail;
    }
    const toolDetail = extractCursorToolContentText(toolCall);
    if (toolDetail) {
      return toolDetail;
    }
    const title = resolveCursorToolTitle(itemType, asString(toolCall.title));
    if (title.length > 0 && title !== defaultCursorToolTitle(itemType)) {
      return title;
    }
  }

  for (const key of [
    "command",
    "title",
    "message",
    "reason",
    "toolName",
    "tool",
    "filePath",
    "path",
  ] as const) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }

  const request = asObject(record.request);
  if (!request) {
    return undefined;
  }

  for (const key of [
    "command",
    "title",
    "message",
    "reason",
    "toolName",
    "tool",
    "filePath",
    "path",
  ] as const) {
    const value = asString(request[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function streamKindFromUpdateKind(updateKind: string): RuntimeContentStreamKind {
  const normalized = updateKind.toLowerCase();
  if (normalized.includes("summary")) {
    return "reasoning_summary_text";
  }
  if (
    normalized.includes("reason") ||
    normalized.includes("thought") ||
    normalized.includes("thinking")
  ) {
    return "reasoning_text";
  }
  if (normalized.includes("plan")) {
    return "plan_text";
  }
  return "assistant_text";
}

export function permissionOptionKindForRuntimeMode(runtimeMode: ProviderSession["runtimeMode"]): {
  readonly primary: CursorPermissionOptionKind;
  readonly fallback: CursorPermissionOptionKind;
  readonly decision: ProviderApprovalDecision;
} {
  if (runtimeMode === "full-access") {
    return {
      primary: "allow_always",
      fallback: "allow_once",
      decision: "acceptForSession",
    };
  }

  return {
    primary: "allow_once",
    fallback: "allow_always",
    decision: "accept",
  };
}

export function parseCursorPermissionOptions(
  value: unknown,
): ReadonlyArray<CursorPermissionOption> {
  const options = asArray(value);
  if (!options) {
    return [];
  }
  const parsed: Array<CursorPermissionOption> = [];
  for (const option of options) {
    const entry = asObject(option);
    if (!entry) {
      continue;
    }
    const optionId = asString(entry.optionId);
    if (!optionId) {
      continue;
    }
    const normalized: {
      optionId: string;
      kind?: CursorPermissionOptionKind;
      name?: string;
    } = { optionId };
    const kind = asString(entry.kind)?.toLowerCase();
    if (
      kind === "allow_once" ||
      kind === "allow_always" ||
      kind === "reject_once" ||
      kind === "reject_always"
    ) {
      normalized.kind = kind;
    }
    const name = asString(entry.name);
    if (name) {
      normalized.name = name;
    }
    parsed.push(normalized);
  }
  return parsed;
}

export function cursorPermissionKindsForDecision(
  decision: ProviderApprovalDecision,
): ReadonlyArray<CursorPermissionOptionKind> {
  switch (decision) {
    case "acceptForSession":
      return ["allow_always", "allow_once"];
    case "accept":
      return ["allow_once", "allow_always"];
    case "decline":
    case "cancel":
    default:
      return ["reject_once", "reject_always"];
  }
}

export function cursorPermissionKindsForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): ReadonlyArray<CursorPermissionOptionKind> {
  return runtimeMode === "full-access"
    ? ["allow_always", "allow_once"]
    : ["allow_once", "allow_always"];
}

function permissionOptionMatchesKind(
  option: CursorPermissionOption,
  kind: CursorPermissionOptionKind,
): boolean {
  if (option.kind === kind) {
    return true;
  }
  const normalizedOptionId = option.optionId.toLowerCase();
  const normalizedName = option.name?.toLowerCase() ?? "";
  switch (kind) {
    case "allow_once":
      return (
        (normalizedOptionId.includes("allow") || normalizedName.includes("allow")) &&
        (normalizedOptionId.includes("once") || normalizedName.includes("once"))
      );
    case "allow_always":
      return (
        (normalizedOptionId.includes("allow") || normalizedName.includes("allow")) &&
        (normalizedOptionId.includes("always") ||
          normalizedOptionId.includes("session") ||
          normalizedName.includes("always") ||
          normalizedName.includes("session"))
      );
    case "reject_once":
      return (
        normalizedOptionId.includes("reject") ||
        normalizedOptionId.includes("deny") ||
        normalizedName.includes("reject") ||
        normalizedName.includes("deny")
      );
    case "reject_always":
      return (
        (normalizedOptionId.includes("reject") ||
          normalizedOptionId.includes("deny") ||
          normalizedName.includes("reject") ||
          normalizedName.includes("deny")) &&
        (normalizedOptionId.includes("always") ||
          normalizedOptionId.includes("session") ||
          normalizedName.includes("always") ||
          normalizedName.includes("session"))
      );
  }
}

export function selectCursorPermissionOption(
  options: ReadonlyArray<CursorPermissionOption>,
  preferredKinds: ReadonlyArray<CursorPermissionOptionKind>,
): CursorPermissionOption | undefined {
  for (const kind of preferredKinds) {
    const matched = options.find((option) => permissionOptionMatchesKind(option, kind));
    if (matched) {
      return matched;
    }
  }
  return preferredKinds.every((kind) => kind.startsWith("allow_")) ? options[0] : undefined;
}
