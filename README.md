# Console MCP Server — macOS & iOS Log Streaming for AI Assistants

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for streaming and searching macOS Console.app and iOS device logs directly from Claude, GitHub Copilot, or any MCP-compatible AI assistant.

Stream real-time logs, search crash reports, filter by severity, and debug iOS simulators and physical devices — all through natural language.

## Features

- **List Devices** - Show connected iOS devices
- **List Simulators** - Show available iOS Simulators
- **Get Logs** - Fetch recent logs filtered by process or subsystem
- **Get Device Logs** - Fetch logs from connected iOS devices
- **Get Simulator Logs** - Fetch logs from iOS Simulators
- **Get Logs by Level** - Filter logs by severity (fault, error, warning, info, debug)
- **Stream Logs** - Capture live logs for a specified duration
- **Search Logs** - Search through historical logs (supports regex)
- **Get Crash Logs** - List and read crash reports
- **Watch for Pattern** - Stream until a pattern matches
- **Export Logs** - Save logs to file for sharing
- **VPN Logs** - Quick shortcut to get WorxVPN-specific logs

## Installation

```bash
git clone https://github.com/rohithgoud30/console-mcp.git
cd console-mcp
npm install
npm run build
```

### For iOS Device Logs

Install libimobiledevice for direct iOS device log streaming:

```bash
brew install libimobiledevice
```

## Configuration

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "console": {
      "command": "node",
      "args": ["/path/to/console-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### `list_devices`
List connected iOS devices with their UDIDs.

### `list_simulators`
List available iOS Simulators.

| Parameter | Type | Description |
|-----------|------|-------------|
| `onlyBooted` | boolean | Only show running simulators (default: false) |
| `runtime` | string | Filter by runtime (e.g., 'iOS 17') |

### `get_logs`
Get recent logs from macOS.

| Parameter | Type | Description |
|-----------|------|-------------|
| `process` | string | Filter by process name (e.g., 'Safari') |
| `subsystem` | string | Filter by subsystem (e.g., 'com.apple.network') |
| `lastMinutes` | number | Minutes of logs to fetch (default: 5) |
| `maxLines` | number | Max lines to return (default: 200) |

### `get_logs_by_level`
Get logs filtered by severity level.

| Parameter | Type | Description |
|-----------|------|-------------|
| `level` | string | Log level: fault, error, warning, info, debug (required) |
| `process` | string | Filter by process name |
| `lastMinutes` | number | Minutes of logs to fetch (default: 5) |
| `maxLines` | number | Max lines to return (default: 200) |

### `get_device_logs`
Get logs from a connected iOS device. Requires `libimobiledevice`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `device` | string | Device name or UDID (required) |
| `process` | string | Filter by process name |
| `lastMinutes` | number | Minutes of logs to capture (default: 5, max: 10) |
| `maxLines` | number | Max lines to return (default: 200) |

### `get_simulator_logs`
Get logs from an iOS Simulator. Simulator must be booted.

| Parameter | Type | Description |
|-----------|------|-------------|
| `simulator` | string | Simulator name or UDID (required) |
| `process` | string | Filter by process name |
| `lastMinutes` | number | Minutes of logs to fetch (default: 5) |
| `maxLines` | number | Max lines to return (default: 200) |

### `stream_logs`
Stream live logs for a duration.

| Parameter | Type | Description |
|-----------|------|-------------|
| `process` | string | Filter by process name |
| `durationSeconds` | number | How long to stream (default: 10, max: 30) |

### `stream_simulator_logs`
Stream live logs from an iOS Simulator.

| Parameter | Type | Description |
|-----------|------|-------------|
| `simulator` | string | Simulator name or UDID (required) |
| `process` | string | Filter by process name |
| `durationSeconds` | number | How long to stream (default: 10, max: 30) |

### `search_logs`
Search through recent logs with text or regex.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Text or regex pattern to search for (required) |
| `useRegex` | boolean | Treat query as regex (default: false) |
| `lastMinutes` | number | Minutes to search (default: 30) |
| `maxLines` | number | Max matching lines (default: 100) |

### `get_crash_logs`
List recent crash reports from DiagnosticReports.

| Parameter | Type | Description |
|-----------|------|-------------|
| `process` | string | Filter by process/app name |
| `lastDays` | number | Days to search back (default: 7) |
| `maxReports` | number | Max reports to list (default: 10) |

### `read_crash_report`
Read the full content of a specific crash report.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filename` | string | Crash report filename (required) |

### `watch_for_pattern`
Stream logs until a pattern matches. Great for test automation.

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Text or regex to watch for (required) |
| `useRegex` | boolean | Treat pattern as regex (default: false) |
| `process` | string | Filter by process name |
| `timeoutSeconds` | number | Max wait time (default: 30, max: 60) |

### `export_logs`
Export logs to a file on the Desktop.

| Parameter | Type | Description |
|-----------|------|-------------|
| `logs` | string | Log content to export (required) |
| `filename` | string | Optional filename |
| `format` | string | Export format: txt or json (default: txt) |

### `get_vpn_logs`
Shortcut to get WorxVPN extension logs.

| Parameter | Type | Description |
|-----------|------|-------------|
| `lastMinutes` | number | Minutes of logs (default: 5) |
| `maxLines` | number | Max lines (default: 300) |

## Usage Examples

```
// In Copilot chat:
"List my iOS simulators"
"Get logs from iPhone 15 Pro simulator"
"Show device logs from my iPhone"
"Get the last 5 minutes of Safari logs"
"Show me all error logs from the last 10 minutes"
"Search logs for 'authentication' using regex"
"Get crash logs for MyApp"
"Read the crash report MyApp-2024-12-27.crash"
"Watch for 'connection established' while I connect"
"Export these logs to a file"
"Stream logs for 15 seconds while I reproduce the bug"
"Show me WorxVPN logs"
```

## Requirements

- macOS 13+ (Ventura or later)
- Node.js 18+
- Xcode (for simulators and `xcrun` tools)
- `libimobiledevice` (optional, for iOS device logs)

## Notes

- macOS `log` command is used for local logs
- `xcrun simctl` is used for simulator logs
- `idevicesyslog` from libimobiledevice is used for iOS device logs
- iOS device must be paired and trusted for log access
- Crash reports are found in `~/Library/Logs/DiagnosticReports`
- Exported logs are saved to `~/Desktop/ConsoleMCP-Exports/`

## Credits

Originally created by [devstroop](https://github.com/devstroop/console-mcp). This fork includes custom modifications and enhancements.

## License

MIT
