# OpenClaw PR #66542 - MCP Auto-Reconnect Analysis

**Date:** 2026-04-26
**PR:** openclaw/openclaw#66542
**PR State:** OPEN (not yet merged)
**Author:** David Rudduck
**Title:** feat(mcp): add reconnect with retry, jitter, parallel startup, and dead-server tracking
**Changes:** +359 / -88 lines (single file: `src/agents/pi-bundle-mcp-runtime.ts`)
**Our Version:** 2026.4.21 (installed 2026-04-22)

---

## PR Summary

This PR adds comprehensive MCP server reconnection capabilities to handle dead child processes. Key features:

1. **Reconnect state machine** per server: absent -> inFlight -> healthy -> dead
2. **Retry with jitter** on transport failures (avoids thundering herd)
3. **Parallel startup** (servers connect concurrently via `Promise.allSettled` instead of sequential `for` loop)
4. **Dead server tracking** with resurrection after 5 minutes
5. **Transport error discrimination** (only reconnects on transport errors, not JSON-RPC protocol errors)
6. **Configurable retry delays** via `retryDelays` and `startupRetryDelays` in openclaw.json
7. **Caller wait timeout** (10s max wait for reconnect before rejecting)

## Functions Modified

### New functions/constants added:
- `ReconnectState` type
- `DEFAULT_RECONNECT_RETRY_DELAYS_S` = [30, 60, 120]
- `DEFAULT_STARTUP_RETRY_DELAYS_S` = [2, 5]
- `CALLER_RECONNECT_WAIT_MS` = 10,000
- `DEAD_RESURRECT_MS` = 300,000 (5 min)
- `getMcpRetryDelays()` - reads per-server config
- `sleep()` / `jitteredSleep()` - delay helpers
- `isLikelyTransportError()` - discriminates transport vs protocol errors
- `makeSession()` - single-attempt connection factory (extracted from getCatalog)
- `connectWithRetries()` - retry loop with jitter
- `reconnectSession()` - deduplicating reconnect orchestrator

### Heavily modified:
- `getCatalog()` - rewritten for parallel startup via Promise.allSettled
- `callTool()` - now catches transport errors and triggers reconnectSession()
- `dispose()` - clears reconnectStates map

### Unchanged:
- `connectWithTimeout()` - still used internally by makeSession
- `listAllTools()` - unchanged
- `disposeSession()` - unchanged
- `BundleMcpSession` type - only added `description` field

## Our Current Bundle Analysis

**File:** `/home/david/.local/lib/node_modules/openclaw/dist/pi-bundle-mcp-runtime-CysvYP7C.js`
**Size:** 601 lines (minified/bundled JS)
**No existing patches detected** - file is stock from 2026.4.21

### Current callTool (lines 484-492):
```javascript
async callTool(serverName, toolName, input) {
    failIfDisposed();
    await getCatalog();
    const session = sessions.get(serverName);
    if (!session) throw new Error(`bundle-mcp server "${serverName}" is not connected`);
    return await session.client.callTool({
        name: toolName,
        arguments: isMcpConfigRecord(input) ? input : {}
    });
},
```

### Current getCatalog (lines 385-469):
- Sequential server connection (for...of loop)
- No retry on failure
- Failed servers silently skipped with warning log
- No reconnect infrastructure

## Applicability Assessment

### Can we apply this to our installed version?

**Verdict: TECHNICALLY POSSIBLE but HIGH RISK and NOT RECOMMENDED for manual patching.**

### Reasons:

**1. Scope of changes is massive**
The PR modifies 447 lines in a single source file. The bundle is minified JS where a single misplaced character breaks everything. The changes touch:
- The `BundleMcpSession` type (adds `description` field)
- The entire `getCatalog()` flow (rewritten from sequential to parallel)
- The `callTool()` method (error catching + reconnect logic)
- The `dispose()` method (reconnectStates cleanup)
- Plus 7 new functions/constants that must be injected

**2. Bundle is minified**
Our file is `pi-bundle-mcp-runtime-CysvYP7C.js` -- a bundled, lightly minified output. Variable names are partially preserved but the structure differs from source TypeScript. TypeScript types are erased. Mapping PR changes to bundle offsets requires careful manual translation.

**3. getCatalog() rewrite is the hardest part**
The PR rewrites getCatalog from a sequential for-loop to a two-pass approach (pre-pass for safe names + Promise.allSettled for parallel connect). This is a ~80-line structural rewrite that cannot be cherry-picked as a small patch.

**4. No existing patches to conflict with**
We verified the file is stock -- no timeout fix or other patches applied. This simplifies things slightly (no merge conflicts), but the sheer volume of changes remains the problem.

### What CAN be done as a minimal patch:

If the goal is specifically "reconnect dead MCP child processes," a minimal version of the callTool reconnect could be applied WITHOUT the full getCatalog rewrite:

```javascript
// Minimal reconnect patch for callTool (conceptual)
async callTool(serverName, toolName, input) {
    failIfDisposed();
    await getCatalog();
    let session = sessions.get(serverName);
    if (!session) throw new Error(`bundle-mcp server "${serverName}" is not connected`);
    const args = isMcpConfigRecord(input) ? input : {};
    try {
        return await session.client.callTool({ name: toolName, arguments: args });
    } catch (error) {
        // Reconnect attempt on transport failure
        failIfDisposed();
        logWarn(`bundle-mcp: tool call failed for "${serverName}", attempting reconnect`);
        const rawServer = loaded.mcpServers[serverName];
        if (!rawServer) throw error;
        await disposeSession(session);
        sessions.delete(serverName);
        // Re-resolve and reconnect
        const resolved = resolveMcpTransport(serverName, rawServer);
        if (!resolved) throw error;
        const newClient = new Client({ name: "openclaw-bundle-mcp", version: "0.0.0" }, {});
        const newSession = { serverName, client: newClient, transport: resolved.transport, transportType: resolved.transportType, detachStderr: resolved.detachStderr };
        await connectWithTimeout(newClient, resolved.transport, resolved.connectionTimeoutMs);
        sessions.set(serverName, newSession);
        return await newSession.client.callTool({ name: toolName, arguments: args });
    }
},
```

This would give us single-attempt reconnect without the full retry/jitter/parallel/dead-tracking infrastructure.

## Recommendation

**Wait for the PR to merge and upgrade OpenClaw.** The PR is labeled `size: M` and touches a single file. Once merged into a release, upgrading will get all features cleanly.

If MCP child process deaths are causing acute pain right now, the minimal callTool-only patch above could be applied as a stopgap, but:
- It must be removed when upgrading
- It lacks retry/jitter (single reconnect attempt)
- It lacks dead-server tracking (will retry every call)
- It lacks the parallel startup improvement

**The PR is still OPEN and not merged.** It may undergo review changes before merging.
