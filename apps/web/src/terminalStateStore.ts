/**
 * Single Zustand store for terminal UI state keyed by threadId.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  normalizeTerminalColorName,
  normalizeTerminalIconName,
  type TerminalColorName,
  type TerminalIconName,
} from "./lib/terminalAppearance";
import { resolveStorage } from "./lib/storage";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";

interface ThreadTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalSidebarWidth: number;
  terminalSidebarDensity: "compact" | "comfortable";
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  customTerminalTitlesById: Record<string, string>;
  autoTerminalTitlesById: Record<string, string>;
  terminalIconsById: Record<string, TerminalIconName>;
  terminalColorsById: Record<string, TerminalColorName>;
  splitRatiosByGroupId: Record<string, number[]>;
}

const TERMINAL_STATE_STORAGE_KEY = "t3code:terminal-state:v1";
const DEFAULT_TERMINAL_SIDEBAR_WIDTH = 236;
const MIN_TERMINAL_SIDEBAR_WIDTH = 180;
const MAX_TERMINAL_SIDEBAR_WIDTH = 360;

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeTerminalSidebarWidth(width: number | null | undefined): number {
  const safeWidth =
    typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_TERMINAL_SIDEBAR_WIDTH;
  return Math.min(
    MAX_TERMINAL_SIDEBAR_WIDTH,
    Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, Math.round(safeWidth)),
  );
}

function normalizeTerminalSidebarDensity(
  density: string | null | undefined,
): "compact" | "comfortable" {
  return density === "compact" ? "compact" : "comfortable";
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function normalizeTerminalTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  return normalized.slice(0, 80);
}

function normalizeTerminalTitleMap(
  titlesById: Record<string, string> | null | undefined,
  terminalIds: string[],
): Record<string, string> {
  if (!titlesById || typeof titlesById !== "object") {
    return {};
  }
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries: Array<[string, string]> = [];
  for (const [terminalId, title] of Object.entries(titlesById)) {
    if (!validTerminalIdSet.has(terminalId)) continue;
    const normalizedTitle = normalizeTerminalTitle(title);
    if (!normalizedTitle) continue;
    normalizedEntries.push([terminalId, normalizedTitle]);
  }
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalMetadataMap<T extends string>(
  metadataById: Record<string, string> | null | undefined,
  terminalIds: string[],
  normalizer: (value: string | null | undefined) => T | null,
): Record<string, T> {
  if (!metadataById || typeof metadataById !== "object") {
    return {};
  }
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries: Array<[string, T]> = [];
  for (const [terminalId, value] of Object.entries(metadataById)) {
    if (!validTerminalIdSet.has(terminalId)) continue;
    const normalizedValue = normalizer(value);
    if (!normalizedValue) continue;
    normalizedEntries.push([terminalId, normalizedValue]);
  }
  return Object.fromEntries(normalizedEntries);
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function createEqualSplitRatios(count: number): number[] {
  if (count <= 0) return [];
  const ratio = 1 / count;
  return Array.from({ length: count }, () => ratio);
}

function normalizeSplitRatios(ratios: number[] | null | undefined, count: number): number[] {
  if (count <= 0) return [];
  if (!Array.isArray(ratios) || ratios.length !== count) {
    return createEqualSplitRatios(count);
  }
  const sanitized = ratios.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return createEqualSplitRatios(count);
  }
  return sanitized.map((value) => value / total);
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

function normalizeSplitRatiosByGroupId(
  splitRatiosByGroupId: Record<string, number[]> | null | undefined,
  terminalGroups: ThreadTerminalGroup[],
): Record<string, number[]> {
  const source =
    splitRatiosByGroupId && typeof splitRatiosByGroupId === "object" ? splitRatiosByGroupId : {};
  return Object.fromEntries(
    terminalGroups.map((group) => [
      group.id,
      normalizeSplitRatios(source[group.id], group.terminalIds.length),
    ]),
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function numberArraysEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) return false;
    if (Math.abs(leftValue - rightValue) > 0.0001) return false;
  }
  return true;
}

function stringRecordEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (!arraysEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function splitRatioRecordEqual(
  left: Record<string, number[]>,
  right: Record<string, number[]>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (!arraysEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (!leftValue || !rightValue) return false;
    return numberArraysEqual(leftValue, rightValue);
  });
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.terminalSidebarWidth === right.terminalSidebarWidth &&
    left.terminalSidebarDensity === right.terminalSidebarDensity &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups) &&
    stringRecordEqual(left.customTerminalTitlesById, right.customTerminalTitlesById) &&
    stringRecordEqual(left.autoTerminalTitlesById, right.autoTerminalTitlesById) &&
    stringRecordEqual(left.terminalIconsById, right.terminalIconsById) &&
    stringRecordEqual(left.terminalColorsById, right.terminalColorsById) &&
    splitRatioRecordEqual(left.splitRatiosByGroupId, right.splitRatiosByGroupId)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalSidebarWidth: DEFAULT_TERMINAL_SIDEBAR_WIDTH,
  terminalSidebarDensity: "comfortable",
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  customTerminalTitlesById: {},
  autoTerminalTitlesById: {},
  terminalIconsById: {},
  terminalColorsById: {},
  splitRatiosByGroupId: {
    [fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID)]: [1],
  },
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
    customTerminalTitlesById: { ...DEFAULT_THREAD_TERMINAL_STATE.customTerminalTitlesById },
    autoTerminalTitlesById: { ...DEFAULT_THREAD_TERMINAL_STATE.autoTerminalTitlesById },
    terminalIconsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalIconsById },
    terminalColorsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalColorsById },
    splitRatiosByGroupId: copySplitRatiosByGroupId(
      DEFAULT_THREAD_TERMINAL_STATE.splitRatiosByGroupId,
    ),
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const customTerminalTitlesById = normalizeTerminalTitleMap(
    state.customTerminalTitlesById,
    nextTerminalIds,
  );
  const autoTerminalTitlesById = normalizeTerminalTitleMap(
    state.autoTerminalTitlesById,
    nextTerminalIds,
  );
  const terminalIconsById = normalizeTerminalMetadataMap(
    state.terminalIconsById,
    nextTerminalIds,
    normalizeTerminalIconName,
  );
  const terminalColorsById = normalizeTerminalMetadataMap(
    state.terminalColorsById,
    nextTerminalIds,
    normalizeTerminalColorName,
  );
  const splitRatiosByGroupId = normalizeSplitRatiosByGroupId(
    state.splitRatiosByGroupId,
    terminalGroups,
  );
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalSidebarWidth: normalizeTerminalSidebarWidth(state.terminalSidebarWidth),
    terminalSidebarDensity: normalizeTerminalSidebarDensity(state.terminalSidebarDensity),
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    customTerminalTitlesById,
    autoTerminalTitlesById,
    terminalIconsById,
    terminalColorsById,
    splitRatiosByGroupId,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  };
  return threadTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }));
}

function copySplitRatiosByGroupId(
  splitRatiosByGroupId: Record<string, number[]>,
): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(splitRatiosByGroupId).map(([groupId, ratios]) => [groupId, [...ratios]]),
  );
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalState,
  terminalId: string,
  mode: "split" | "new",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function setThreadTerminalSidebarWidth(
  state: ThreadTerminalState,
  width: number,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextWidth = normalizeTerminalSidebarWidth(width);
  if (normalized.terminalSidebarWidth === nextWidth) {
    return normalized;
  }
  return { ...normalized, terminalSidebarWidth: nextWidth };
}

function setThreadTerminalSidebarDensity(
  state: ThreadTerminalState,
  density: "compact" | "comfortable",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextDensity = normalizeTerminalSidebarDensity(density);
  if (normalized.terminalSidebarDensity === nextDensity) {
    return normalized;
  }
  return { ...normalized, terminalSidebarDensity: nextDensity };
}

function splitThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split");
}

function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : normalized.activeTerminalId;

  const terminalGroups = normalized.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalSidebarWidth: normalized.terminalSidebarWidth,
    terminalSidebarDensity: normalized.terminalSidebarDensity,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
    customTerminalTitlesById: normalized.customTerminalTitlesById,
    autoTerminalTitlesById: normalized.autoTerminalTitlesById,
    terminalIconsById: normalized.terminalIconsById,
    terminalColorsById: normalized.terminalColorsById,
    splitRatiosByGroupId: normalized.splitRatiosByGroupId,
  });
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

function setThreadTerminalCustomTitle(
  state: ThreadTerminalState,
  terminalId: string,
  title: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedTitle = normalizeTerminalTitle(title);
  const currentTitle = normalized.customTerminalTitlesById[terminalId] ?? null;
  if (currentTitle === normalizedTitle) {
    return normalized;
  }
  const customTerminalTitlesById = { ...normalized.customTerminalTitlesById };
  if (normalizedTitle) {
    customTerminalTitlesById[terminalId] = normalizedTitle;
  } else {
    delete customTerminalTitlesById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    customTerminalTitlesById,
  });
}

function setThreadTerminalAutoTitle(
  state: ThreadTerminalState,
  terminalId: string,
  title: string | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedTitle = normalizeTerminalTitle(title);
  const currentTitle = normalized.autoTerminalTitlesById[terminalId] ?? null;
  if (currentTitle === normalizedTitle) {
    return normalized;
  }
  const autoTerminalTitlesById = { ...normalized.autoTerminalTitlesById };
  if (normalizedTitle) {
    autoTerminalTitlesById[terminalId] = normalizedTitle;
  } else {
    delete autoTerminalTitlesById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    autoTerminalTitlesById,
  });
}

function setThreadTerminalIcon(
  state: ThreadTerminalState,
  terminalId: string,
  icon: TerminalIconName | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedIcon = normalizeTerminalIconName(icon);
  const currentIcon = normalized.terminalIconsById[terminalId] ?? null;
  if (currentIcon === normalizedIcon) {
    return normalized;
  }
  const terminalIconsById = { ...normalized.terminalIconsById };
  if (normalizedIcon) {
    terminalIconsById[terminalId] = normalizedIcon;
  } else {
    delete terminalIconsById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    terminalIconsById,
  });
}

function setThreadTerminalColor(
  state: ThreadTerminalState,
  terminalId: string,
  color: TerminalColorName | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedColor = normalizeTerminalColorName(color);
  const currentColor = normalized.terminalColorsById[terminalId] ?? null;
  if (currentColor === normalizedColor) {
    return normalized;
  }
  const terminalColorsById = { ...normalized.terminalColorsById };
  if (normalizedColor) {
    terminalColorsById[terminalId] = normalizedColor;
  } else {
    delete terminalColorsById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    terminalColorsById,
  });
}

function setThreadTerminalGroupSplitRatios(
  state: ThreadTerminalState,
  groupId: string,
  ratios: number[],
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const group = normalized.terminalGroups.find((candidate) => candidate.id === groupId);
  if (!group) {
    return normalized;
  }
  const nextRatios = normalizeSplitRatios(ratios, group.terminalIds.length);
  const currentRatios = normalized.splitRatiosByGroupId[groupId];
  if (currentRatios && numberArraysEqual(currentRatios, nextRatios)) {
    return normalized;
  }
  return normalizeThreadTerminalState({
    ...normalized,
    splitRatiosByGroupId: {
      ...normalized.splitRatiosByGroupId,
      [groupId]: nextRatios,
    },
  });
}

function moveThreadTerminal(
  state: ThreadTerminalState,
  terminalId: string,
  targetGroupId: string,
  targetIndex: number,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const sourceGroupIndex = normalized.terminalGroups.findIndex((group) =>
    group.terminalIds.includes(terminalId),
  );
  const targetGroupIndex = normalized.terminalGroups.findIndex(
    (group) => group.id === targetGroupId,
  );
  if (sourceGroupIndex < 0 || targetGroupIndex < 0) {
    return normalized;
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  const sourceGroup = terminalGroups[sourceGroupIndex];
  const initialTargetGroup = terminalGroups[targetGroupIndex];
  if (!sourceGroup || !initialTargetGroup) {
    return normalized;
  }

  const sourceIndex = sourceGroup.terminalIds.indexOf(terminalId);
  if (sourceIndex < 0) {
    return normalized;
  }

  if (
    sourceGroup.id !== initialTargetGroup.id &&
    initialTargetGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  sourceGroup.terminalIds.splice(sourceIndex, 1);
  let nextTargetGroupIndex = targetGroupIndex;
  if (sourceGroup.terminalIds.length === 0) {
    terminalGroups.splice(sourceGroupIndex, 1);
    if (sourceGroupIndex < targetGroupIndex) {
      nextTargetGroupIndex -= 1;
    }
  }

  const targetGroup = terminalGroups[nextTargetGroupIndex];
  if (!targetGroup) {
    return normalized;
  }

  let insertionIndex = Math.max(0, Math.min(targetIndex, targetGroup.terminalIds.length));
  if (sourceGroup.id === targetGroup.id && sourceIndex < insertionIndex) {
    insertionIndex -= 1;
  }

  const targetIds = targetGroup.terminalIds;
  if (sourceGroup.id === targetGroup.id && sourceIndex === insertionIndex) {
    return normalized;
  }

  targetIds.splice(insertionIndex, 0, terminalId);
  const terminalIds = terminalGroups.flatMap((group) => group.terminalIds);
  const activeTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(normalized.activeTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(normalized.activeTerminalId);

  return normalizeThreadTerminalState({
    ...normalized,
    terminalIds,
    terminalGroups,
    activeTerminalGroupId,
  });
}

function moveThreadTerminalToNewGroup(
  state: ThreadTerminalState,
  terminalId: string,
  targetGroupIndex: number,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const sourceGroupIndex = normalized.terminalGroups.findIndex((group) =>
    group.terminalIds.includes(terminalId),
  );
  if (sourceGroupIndex < 0) {
    return normalized;
  }

  const sourceGroup = normalized.terminalGroups[sourceGroupIndex];
  if (!sourceGroup) {
    return normalized;
  }
  if (sourceGroup.terminalIds.length === 1) {
    return normalized;
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  const mutableSourceGroup = terminalGroups[sourceGroupIndex];
  if (!mutableSourceGroup) {
    return normalized;
  }
  mutableSourceGroup.terminalIds = mutableSourceGroup.terminalIds.filter((id) => id !== terminalId);

  const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
  const newGroup: ThreadTerminalGroup = {
    id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
    terminalIds: [terminalId],
  };
  const insertionIndex = Math.max(0, Math.min(targetGroupIndex, terminalGroups.length));
  terminalGroups.splice(insertionIndex, 0, newGroup);

  const terminalIds = terminalGroups.flatMap((group) => group.terminalIds);
  return normalizeThreadTerminalState({
    ...normalized,
    terminalIds,
    terminalGroups,
    activeTerminalGroupId:
      terminalGroups.find((group) => group.terminalIds.includes(normalized.activeTerminalId))?.id ??
      terminalGroups[0]?.id ??
      fallbackGroupId(normalized.activeTerminalId),
  });
}

export function selectThreadTerminalState(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
): ThreadTerminalState {
  if (threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByThreadId[threadId] ?? getDefaultThreadTerminalState();
}

function updateTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<ThreadId, ThreadTerminalState> {
  if (threadId.length === 0) {
    return terminalStateByThreadId;
  }

  const current = selectThreadTerminalState(terminalStateByThreadId, threadId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadId;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadId[threadId] === undefined) {
      return terminalStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = terminalStateByThreadId;
    return rest as Record<ThreadId, ThreadTerminalState>;
  }

  return {
    ...terminalStateByThreadId,
    [threadId]: next,
  };
}

interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  setTerminalSidebarWidth: (threadId: ThreadId, width: number) => void;
  setTerminalSidebarDensity: (threadId: ThreadId, density: "compact" | "comfortable") => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  moveTerminal: (
    threadId: ThreadId,
    terminalId: string,
    targetGroupId: string,
    targetIndex: number,
  ) => void;
  moveTerminalToNewGroup: (
    threadId: ThreadId,
    terminalId: string,
    targetGroupIndex: number,
  ) => void;
  renameTerminal: (threadId: ThreadId, terminalId: string, title: string) => void;
  setTerminalAutoTitle: (threadId: ThreadId, terminalId: string, title: string | null) => void;
  setTerminalIcon: (threadId: ThreadId, terminalId: string, icon: TerminalIconName | null) => void;
  setTerminalColor: (
    threadId: ThreadId,
    terminalId: string,
    color: TerminalColorName | null,
  ) => void;
  setTerminalGroupSplitRatios: (threadId: ThreadId, groupId: string, ratios: number[]) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadId: ThreadId,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
            state.terminalStateByThreadId,
            threadId,
            updater,
          );
          if (nextTerminalStateByThreadId === state.terminalStateByThreadId) {
            return state;
          }
          return {
            terminalStateByThreadId: nextTerminalStateByThreadId,
          };
        });
      };

      return {
        terminalStateByThreadId: {},
        setTerminalOpen: (threadId, open) =>
          updateTerminal(threadId, (state) => setThreadTerminalOpen(state, open)),
        setTerminalHeight: (threadId, height) =>
          updateTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
        setTerminalSidebarWidth: (threadId, width) =>
          updateTerminal(threadId, (state) => setThreadTerminalSidebarWidth(state, width)),
        setTerminalSidebarDensity: (threadId, density) =>
          updateTerminal(threadId, (state) => setThreadTerminalSidebarDensity(state, density)),
        splitTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
        setActiveTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
        moveTerminal: (threadId, terminalId, targetGroupId, targetIndex) =>
          updateTerminal(threadId, (state) =>
            moveThreadTerminal(state, terminalId, targetGroupId, targetIndex),
          ),
        moveTerminalToNewGroup: (threadId, terminalId, targetGroupIndex) =>
          updateTerminal(threadId, (state) =>
            moveThreadTerminalToNewGroup(state, terminalId, targetGroupIndex),
          ),
        renameTerminal: (threadId, terminalId, title) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalCustomTitle(state, terminalId, title),
          ),
        setTerminalAutoTitle: (threadId, terminalId, title) =>
          updateTerminal(threadId, (state) => setThreadTerminalAutoTitle(state, terminalId, title)),
        setTerminalIcon: (threadId, terminalId, icon) =>
          updateTerminal(threadId, (state) => setThreadTerminalIcon(state, terminalId, icon)),
        setTerminalColor: (threadId, terminalId, color) =>
          updateTerminal(threadId, (state) => setThreadTerminalColor(state, terminalId, color)),
        setTerminalGroupSplitRatios: (threadId, groupId, ratios) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalGroupSplitRatios(state, groupId, ratios),
          ),
        closeTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
        setTerminalActivity: (threadId, terminalId, hasRunningSubprocess) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        clearTerminalState: (threadId) =>
          updateTerminal(threadId, () => createDefaultThreadTerminalState()),
        removeTerminalState: (threadId) =>
          set((state) => {
            if (state.terminalStateByThreadId[threadId] === undefined) {
              return state;
            }
            const next = { ...state.terminalStateByThreadId };
            delete next[threadId];
            return { terminalStateByThreadId: next };
          }),
        removeOrphanedTerminalStates: (activeThreadIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            if (orphanedIds.length === 0) return state;
            const next = { ...state.terminalStateByThreadId };
            for (const id of orphanedIds) {
              delete next[id as ThreadId];
            }
            return { terminalStateByThreadId: next };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 5,
      storage: createJSONStorage(createTerminalStateStorage),
      migrate: (persistedState) => {
        const candidate = persistedState as {
          terminalStateByThreadId?: Record<ThreadId, Partial<ThreadTerminalState>>;
        } | null;
        if (!candidate?.terminalStateByThreadId) {
          return { terminalStateByThreadId: {} };
        }
        const terminalStateByThreadId = Object.fromEntries(
          Object.entries(candidate.terminalStateByThreadId).map(([threadId, threadState]) => [
            threadId,
            normalizeThreadTerminalState({
              ...createDefaultThreadTerminalState(),
              ...(threadState as Partial<ThreadTerminalState>),
            }),
          ]),
        ) as Record<ThreadId, ThreadTerminalState>;
        return { terminalStateByThreadId };
      },
      partialize: (state) => ({
        terminalStateByThreadId: state.terminalStateByThreadId,
      }),
    },
  ),
);
