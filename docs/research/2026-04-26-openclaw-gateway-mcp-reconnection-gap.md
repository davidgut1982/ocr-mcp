# Openclaw Gateway MCP Child Process Reconnection Gap

**Date:** 2026-04-26
**Scope:** `openclaw` gateway bundle-mcp runtime (`pi-bundle-mcp-runtime-CysvYP7C.js`) and `@modelcontextprotocol/sdk` StdioClientTransport
**Classification:** Architectural gap (actionable)

---

## Executive Summary

The openclaw gateway has **zero reconnection logic** for MCP child processes. When a child process (ocr-mcp, fastmail-mcp, etc.) dies or the stdio connection breaks, the gateway returns `"bundle-mcp server "<name>" is not connected"` permanently for that server until the entire session is disposed and recreated. The root cause is a connect-once-cache-forever design with no health checking, no close event handling, and no retry/respawn mechanism.

---

## Root Cause Analysis

### 1. What triggers "Not connected"

File: `pi-bundle-mcp-runtime-CysvYP7C.js`, line 488:

```javascript
async callTool(serverName, toolName, input) {
    failIfDisposed();
    await getCatalog();
    const session = sessions.get(serverName);
    if (!session) throw new Error(`bundle-mcp server "${serverName}" is not connected`);
    return await session.client.callTool({ name: toolName, arguments: ... });
}
```

The error fires when `sessions.get(serverName)` returns `undefined`. This happens in exactly two scenarios:

**Scenario A -- Startup failure:** The server failed to connect during `getCatalog()` initialization (lines 442-446). The catch block calls `disposeSession(session)` and `sessions.delete(serverName)`, permanently removing it.

**Scenario B -- Child death after successful startup:** The child process dies, but the session entry **remains** in the `sessions` Map. Subsequent `callTool` calls find the session but the underlying `client.callTool()` throws a different error -- `"Not connected"` from the SDK's `StdioClientTransport.send()` (line 183 of `stdio.js`), which checks `if (!this._process?.stdin)`. This propagates through the SDK protocol layer as a connection-closed error. The gateway does **not** catch this error, does **not** remove the dead session, and does **not** attempt respawn.

### 2. Session lifecycle is connect-once, cache-forever

The `createSessionMcpRuntime` function (line 370) creates a `sessions` Map and populates it exactly once during `getCatalog()`:

```
getCatalog() called
  -> for each mcpServer in config:
       create Client + Transport
       sessions.set(serverName, session)       // line 417
       connectWithTimeout(client, transport)    // line 420
       listAllTools(client)                     // line 422
  -> cache result in `catalog` variable
  -> never re-run (line 387: if (catalog) return catalog)
```

Once `catalog` is populated, `getCatalog()` short-circuits and never re-evaluates server health. The `sessions` Map is written once and only cleared on full dispose.

### 3. No close/error event handlers on transport or client

The gateway code **never** registers handlers for:
- `transport.onclose` -- fired by StdioClientTransport when child exits (line 90-93 of `stdio.js`)
- `transport.onerror` -- fired on stdin/stdout errors
- `client.onclose` -- fired by the SDK protocol layer when transport closes

The SDK's `Protocol._onclose()` (line 252 of `protocol.js`) does fire when the transport closes, which rejects pending requests and sets `this._transport = undefined`. But the gateway layer above is unaware of this state change.

### 4. No staleness check before `callTool`

Compare with the browser MCP session manager in `server-context-pcd6p7Ew.js` (line 189):

```javascript
if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = void 0;
}
```

The browser session manager checks `transport.pid === null` (which StdioClientTransport sets when the child process closes) and invalidates the session. The bundle-mcp runtime does **not** perform this check.

### 5. The SDK StdioClientTransport has no reconnection

`StdioClientTransport` (file: `stdio.js`) is a one-shot transport:
- `start()` spawns the process once
- `close()` kills it
- When the child dies (`close` event, line 90), it sets `this._process = undefined` and calls `this.onclose?.()`
- There is no `restart()`, `reconnect()`, or auto-respawn capability

---

## Impact

When any bundle-mcp child process crashes, OOMs, or is killed:

1. All subsequent tool calls to that server fail permanently
2. The error message `"bundle-mcp server X is not connected"` gives no indication of recoverability
3. The only recovery path is disposing the entire session runtime (which kills ALL healthy MCP servers too) and recreating it
4. For long-running sessions, this means losing all MCP server state

---

## Where Reconnection Logic Would Go

The fix belongs in `createSessionMcpRuntime` (line 370), specifically in the `callTool` method. There are two complementary approaches:

### Approach A: Reactive reconnect on callTool failure (minimal change)

Wrap `callTool` to catch connection errors, invalidate the dead session, respawn the transport + client, and retry:

```javascript
async callTool(serverName, toolName, input) {
    failIfDisposed();
    await getCatalog();
    let session = sessions.get(serverName);
    if (!session) throw new Error(`bundle-mcp server "${serverName}" is not connected`);

    try {
        return await session.client.callTool({ name: toolName, arguments: ... });
    } catch (err) {
        if (isConnectionError(err)) {
            // Invalidate dead session
            await disposeSession(session);
            sessions.delete(serverName);

            // Respawn from original config
            const resolved = resolveMcpTransport(serverName, rawServerConfig);
            const newClient = new Client(...);
            const newSession = { serverName, client: newClient, transport: resolved.transport, ... };
            await connectWithTimeout(newClient, resolved.transport, resolved.connectionTimeoutMs);
            sessions.set(serverName, newSession);

            // Retry once
            return await newSession.client.callTool({ name: toolName, arguments: ... });
        }
        throw err;
    }
}
```

### Approach B: Proactive health check via transport.onclose (robust)

Register `onclose` handlers during `getCatalog()` to detect child death immediately and either auto-respawn or mark the session as stale for lazy reconnect:

```javascript
// During getCatalog() after successful connect:
session.transport.onclose = () => {
    logWarn(`bundle-mcp: server "${serverName}" disconnected, marking for reconnect`);
    sessions.delete(serverName);
    // Optionally: auto-respawn here
};
```

### Approach C: PID staleness check (simplest, matches browser pattern)

Add the same check that `server-context-pcd6p7Ew.js` uses:

```javascript
async callTool(serverName, toolName, input) {
    failIfDisposed();
    await getCatalog();
    let session = sessions.get(serverName);
    if (session && session.transport.pid === null) {
        await disposeSession(session);
        sessions.delete(serverName);
        session = undefined;
    }
    if (!session) {
        // Attempt reconnect from config...
    }
}
```

---

## Key Files

| File | Purpose |
|------|---------|
| `/home/david/.local/lib/node_modules/openclaw/dist/pi-bundle-mcp-runtime-CysvYP7C.js` | Bundle MCP runtime -- session creation, caching, callTool |
| `/home/david/.local/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js` | StdioClientTransport -- child process spawn, close handling |
| `/home/david/.local/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/dist/cjs/shared/protocol.js` | SDK Protocol base -- onclose propagation, request rejection |
| `/home/david/.local/lib/node_modules/openclaw/dist/server-context-pcd6p7Ew.js` | Browser MCP session manager -- has PID staleness check (contrast) |

---

## Summary of Findings

| Question | Answer |
|----------|--------|
| What triggers "Not connected"? | `sessions.get(serverName)` returns undefined (server never connected), OR SDK transport.send() throws because child process is dead |
| Is there reconnection logic? | **No.** Zero reconnection, zero close-event handling, zero staleness checks |
| Is the session cached permanently? | **Yes.** `getCatalog()` runs once, caches result, never re-evaluates. Sessions Map is write-once. |
| Could we patch the gateway? | **Yes.** The bundle is minified JS but readable. Approach C (PID check) is ~5 lines. The browser session manager already implements this pattern in the same codebase. |
| Does the MCP SDK support reconnection? | **No.** StdioClientTransport is one-shot. Reconnection must be implemented at the gateway layer by creating a new Client+Transport pair. |
