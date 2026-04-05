import type { ProjectEntry } from "@ace/contracts";

export const EDITOR_TAB_TRANSFER_TYPE = "application/x-ace-editor-tab";
export const EXPLORER_ENTRY_TRANSFER_TYPE = "application/x-ace-explorer-entry";

interface ExplorerEntryTransferData {
  kind: ProjectEntry["kind"];
  path: string;
}

interface EditorTabTransferData {
  filePath: string;
  sourcePaneId: string;
}

function parseTransferRecord(raw: string): Record<string, unknown> | null {
  if (raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

export function writeExplorerEntryTransfer(
  dataTransfer: DataTransfer,
  entry: ExplorerEntryTransferData,
): void {
  dataTransfer.setData(EXPLORER_ENTRY_TRANSFER_TYPE, JSON.stringify(entry));
  dataTransfer.setData("text/plain", entry.path);
}

export function readExplorerEntryTransferPath(dataTransfer: DataTransfer): string | null {
  const payload = parseTransferRecord(dataTransfer.getData(EXPLORER_ENTRY_TRANSFER_TYPE));
  return payload ? readTrimmedString(payload, "path") : null;
}

export function readEditorTabTransfer(dataTransfer: DataTransfer): EditorTabTransferData | null {
  const payload = parseTransferRecord(
    dataTransfer.getData(EDITOR_TAB_TRANSFER_TYPE) || dataTransfer.getData("text/plain"),
  );
  if (!payload) {
    return null;
  }
  const filePath = readTrimmedString(payload, "filePath");
  const sourcePaneId = readTrimmedString(payload, "sourcePaneId");
  if (!filePath || !sourcePaneId) {
    return null;
  }
  return { filePath, sourcePaneId };
}
