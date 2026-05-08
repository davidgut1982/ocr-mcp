# OpenClaw Gateway Restart Investigation

**Date:** 2026-04-27
**Investigator:** Research Agent (Claude Opus 4.6)
**Status:** Complete
**Severity:** Medium (operational disruption, not data loss)

## Executive Summary

The openclaw-gateway systemd service is NOT crashing or being OOM-killed. All restarts are manual SIGTERMs triggered by us to recover from MCP child processes entering an unrecoverable "Not connected" state. The gateway itself is stable. The root cause is that openclaw lacks MCP child process health monitoring and auto-respawn capability.

## Findings

### Restart Count and Triggers

- **3 restarts today** (Apr 27): 14:08, 15:16, 17:58 -- all external SIGTERMs
- **25 total starts** in the log file (Apr 22 - Apr 27)
- **Zero crashes, zero OOM kills, zero segfaults** -- gateway never dies on its own
- All restarts triggered by `systemctl --user restart openclaw-gateway`

### MCP Child Disconnection Pattern

The real problem is MCP children silently entering "Not connected" state:

```
[tools] ocr__quick_scan failed: Not connected     (Apr 24, 26, 27 -- frequent)
[tools] fastmail__search_emails failed: Not connected  (Apr 27)
[tools] google-workspace__search_gmail_messages failed: Not connected  (Apr 27)
```

These errors appear WHILE the gateway is running normally. The children lose their stdio connection without any gateway event triggering it.

### Service Configuration Analysis

- `Restart=always` with `RestartSec=5` -- auto-restart on any exit
- `KillMode=control-group` -- correctly kills all children on stop
- `TimeoutStopSec=30` -- 30s grace period for shutdown
- No `MemoryMax` or `MemoryHigh` set -- no memory limits
- Current RSS: 568MB, MemoryPeak: 1.8GB -- no memory pressure

### Orphan Process Status

**No orphans currently.** All MCP children (PIDs 441883-441979) are properly parented to gateway PID 441436. The KillMode=control-group ensures cleanup on restart.

### Hot Reload Capability

The gateway has a `[reload]` system for config changes:
- Some changes apply dynamically (hot reload)
- Some require full restart
- **MCP child reconnect/respawn is NOT part of the reload system**

## Root Cause

1. MCP child processes (ocr-mcp, fastmail-mcp, etc.) silently lose their stdio pipe connection
2. Gateway detects "Not connected" state but has no recovery mechanism
3. We manually restart the entire gateway, disrupting all connected clients and working MCP servers
4. New gateway spawns fresh children -- everything works until the next disconnection

## Recommendations

### Immediate (Do Now)

1. **Stop full gateway restarts for individual MCP failures** -- disrupts everything
2. **Add ExecStartPre cleanup** to systemd unit:
   ```ini
   ExecStartPre=/bin/bash -c 'pkill -f "ocr-mcp|fastmail-mcp|nc-mcp-server|ob1-operating-model-mcp|mcp-remote" 2>/dev/null; sleep 1; true'
   ```

### Short-term (This Week)

3. **Create per-MCP-server restart script** that kills and respawns individual children
4. **Investigate ocr-mcp specifically** -- most frequent offender
5. **Add individual MCP child logging** to capture disconnection events

### Long-term (Upstream)

6. **Report to openclaw**: Request MCP child process watchdog with auto-respawn
7. **Request health-check endpoint** for individual MCP servers via gateway API

## Key Files

- Service unit: `/home/david/.config/systemd/user/openclaw-gateway.service`
- Service overrides: `/home/david/.config/systemd/user/openclaw-gateway.service.d/`
- Gateway log: `/home/david/.openclaw/gateway-live.log`
- Gateway binary: `/home/david/.local/lib/node_modules/openclaw/dist/index.js`
