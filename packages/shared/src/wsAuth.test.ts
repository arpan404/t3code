import { describe, expect, it } from "vitest";

import {
  buildWebSocketAuthProtocol,
  extractWebSocketAuthTokenFromProtocolHeader,
  extractWebSocketClientSessionIdFromProtocolHeader,
  extractWebSocketConnectionIdFromProtocolHeader,
  resolveWebSocketAuthConnection,
} from "./wsAuth";

describe("wsAuth", () => {
  it("encodes auth, session, and connection protocols for websocket transport", () => {
    const resolved = resolveWebSocketAuthConnection("ws://localhost:3000/ws?token=secret", {
      clientSessionId: "session-1",
      connectionId: "connection-1",
    });

    expect(resolved.url).toBe("ws://localhost:3000/ws");
    expect(resolved.protocols).toEqual([
      buildWebSocketAuthProtocol("secret"),
      expect.stringMatching(/^ace-client-session\./u),
      expect.stringMatching(/^ace-connection\./u),
    ]);
  });

  it("extracts all websocket metadata from a protocol header", () => {
    const resolved = resolveWebSocketAuthConnection("ws://localhost:3000/ws?token=secret", {
      clientSessionId: "session-1",
      connectionId: "connection-1",
    });
    const header = resolved.protocols?.join(",");

    expect(extractWebSocketAuthTokenFromProtocolHeader(header)).toBe("secret");
    expect(extractWebSocketClientSessionIdFromProtocolHeader(header)).toBe("session-1");
    expect(extractWebSocketConnectionIdFromProtocolHeader(header)).toBe("connection-1");
  });
});
