const TERMINAL_COMMAND_CONNECTOR = /\s*(?:&&|\|\||[|;])\s*/;

function basename(pathValue: string): string {
  const normalized = pathValue.trim().replace(/[\\/]+$/, "");
  if (normalized.length === 0) return "";
  const segments = normalized.split(/[\\/]+/);
  return segments[segments.length - 1] ?? "";
}

function normalizeTerminalTitle(title: string): string | null {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  return normalized.slice(0, 80);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return matches?.map((token) => stripQuotes(token)) ?? [];
}

export function deriveTerminalTitleFromCommand(command: string): string | null {
  const normalized = command.trim();
  if (normalized.length === 0) return null;

  const primarySegment = normalized.split(TERMINAL_COMMAND_CONNECTOR)[0]?.trim() ?? "";
  if (primarySegment.length === 0) return null;

  const commandWithoutEnv = primarySegment.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/,
    "",
  );
  const commandWithoutPrefix = commandWithoutEnv.replace(/^(?:sudo|env|command)\s+/, "");
  const tokens = tokenizeCommand(commandWithoutPrefix);
  if (tokens.length === 0) return null;

  const binary = basename(tokens[0] ?? "").toLowerCase();
  const arg1 = tokens[1]?.trim();
  const arg2 = tokens[2]?.trim();

  if (["bun", "npm", "pnpm", "yarn"].includes(binary)) {
    if (arg1 && ["run", "x", "exec"].includes(arg1) && arg2) return `${binary} ${arg2}`;
    if (arg1) return `${binary} ${arg1}`;
    return binary;
  }

  if (binary === "git") {
    return arg1 ? `git ${arg1}` : "git";
  }

  if (binary === "docker" && arg1 === "compose") {
    return arg2 ? `docker compose ${arg2}` : "docker compose";
  }

  if (["python", "python3", "node", "deno"].includes(binary)) {
    if (arg1 && !arg1.startsWith("-")) {
      return `${binary} ${basename(arg1)}`;
    }
    return binary;
  }

  if (["cargo", "go", "make", "just"].includes(binary) && arg1) {
    return `${binary} ${arg1}`;
  }

  return binary || null;
}

export function extractTerminalOscTitle(data: string): string | null {
  const oscStart = data.lastIndexOf("\u001b]");
  if (oscStart < 0) return null;
  const payload = data.slice(oscStart + 2);
  if (!(payload.startsWith("0;") || payload.startsWith("2;"))) {
    return null;
  }
  const titlePayload = payload.slice(2);
  const bellIndex = titlePayload.indexOf("\u0007");
  const stIndex = titlePayload.indexOf("\u001b\\");
  const endIndexCandidates = [bellIndex, stIndex].filter((index) => index >= 0);
  const endIndex = endIndexCandidates.length > 0 ? Math.min(...endIndexCandidates) : -1;
  if (endIndex < 0) return null;
  return normalizeTerminalTitle(titlePayload.slice(0, endIndex)) ?? null;
}

export function applyTerminalInputToBuffer(
  buffer: string,
  data: string,
): {
  buffer: string;
  submittedCommand: string | null;
} {
  let nextBuffer = buffer;
  let submittedCommand: string | null = null;

  for (let index = 0; index < data.length; index += 1) {
    const chunk = data[index];
    if (!chunk) continue;

    if (chunk === "\u001b") {
      continue;
    }
    if (chunk === "\r" || chunk === "\n") {
      submittedCommand = nextBuffer.trim().length > 0 ? nextBuffer.trim() : null;
      nextBuffer = "";
      continue;
    }
    if (chunk === "\u007f") {
      nextBuffer = nextBuffer.slice(0, -1);
      continue;
    }
    if (chunk === "\u0015" || chunk === "\u0003") {
      nextBuffer = "";
      continue;
    }
    if (chunk < " ") {
      continue;
    }
    nextBuffer += chunk;
  }

  return { buffer: nextBuffer, submittedCommand };
}
