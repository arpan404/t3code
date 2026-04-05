const WS_AUTH_PROTOCOL_PREFIX = "ace-auth.";
const WS_CLIENT_SESSION_PROTOCOL_PREFIX = "ace-client-session.";
const WS_CONNECTION_PROTOCOL_PREFIX = "ace-connection.";

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bufferCtor = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  const base64 = bufferCtor
    ? bufferCtor.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): string | undefined {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    const bufferCtor = (globalThis as { Buffer?: typeof Buffer }).Buffer;
    const bytes = bufferCtor
      ? new Uint8Array(bufferCtor.from(padded, "base64"))
      : Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

export function buildWebSocketAuthProtocol(authToken: string): string {
  return `${WS_AUTH_PROTOCOL_PREFIX}${encodeBase64Url(authToken)}`;
}

export function buildWebSocketClientSessionProtocol(clientSessionId: string): string {
  return `${WS_CLIENT_SESSION_PROTOCOL_PREFIX}${encodeBase64Url(clientSessionId)}`;
}

export function buildWebSocketConnectionProtocol(connectionId: string): string {
  return `${WS_CONNECTION_PROTOCOL_PREFIX}${encodeBase64Url(connectionId)}`;
}

function extractProtocolValue(
  header: string | null | undefined,
  prefix: string,
): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const entry of header.split(",")) {
    const protocol = entry.trim();
    if (!protocol.startsWith(prefix)) {
      continue;
    }

    const encodedValue = protocol.slice(prefix.length);
    if (encodedValue.length === 0) {
      continue;
    }

    const decodedValue = decodeBase64Url(encodedValue);
    if (decodedValue && decodedValue.length > 0) {
      return decodedValue;
    }
  }

  return undefined;
}

export function extractWebSocketAuthTokenFromProtocolHeader(
  header: string | null | undefined,
): string | undefined {
  return extractProtocolValue(header, WS_AUTH_PROTOCOL_PREFIX);
}

export function extractWebSocketClientSessionIdFromProtocolHeader(
  header: string | null | undefined,
): string | undefined {
  return extractProtocolValue(header, WS_CLIENT_SESSION_PROTOCOL_PREFIX);
}

export function extractWebSocketConnectionIdFromProtocolHeader(
  header: string | null | undefined,
): string | undefined {
  return extractProtocolValue(header, WS_CONNECTION_PROTOCOL_PREFIX);
}

export function resolveWebSocketAuthConnection(
  target: string,
  options?: {
    readonly baseUrl?: string;
    readonly clientSessionId?: string;
    readonly connectionId?: string;
  },
): { readonly url: string; readonly protocols?: ReadonlyArray<string> } {
  const parsed = options?.baseUrl ? new URL(target, options.baseUrl) : new URL(target);
  const authToken = parsed.searchParams.get("token")?.trim() ?? "";

  if (authToken.length > 0) {
    parsed.searchParams.delete("token");
  }

  const protocols: string[] = [];
  if (authToken.length > 0) {
    protocols.push(buildWebSocketAuthProtocol(authToken));
  }
  if (options?.clientSessionId && options.clientSessionId.trim().length > 0) {
    protocols.push(buildWebSocketClientSessionProtocol(options.clientSessionId.trim()));
  }
  if (options?.connectionId && options.connectionId.trim().length > 0) {
    protocols.push(buildWebSocketConnectionProtocol(options.connectionId.trim()));
  }

  return {
    url: parsed.toString(),
    ...(protocols.length > 0 ? { protocols } : {}),
  };
}
