#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import { readdir, readFile, stat, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, basename } from "path";

// Log level types
type LogLevel = "fault" | "error" | "warning" | "info" | "debug" | "default";

// Crash report interface
interface CrashReport {
  filename: string;
  path: string;
  process: string;
  date: Date;
  preview: string;
}

// Store active log streams
const activeStreams: Map<string, ReturnType<typeof spawn>> = new Map();

// Device/Simulator types
interface Device {
  udid: string;
  name: string;
  model: string;
  connectionType?: string;
}

interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
}

// Get list of connected iOS devices
function getConnectedDevices(): Device[] {
  const hasCommand = (command: string) => {
    try {
      execSync(`which ${command}`, { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  };

  const parseIdeviceInfo = (raw: string) => {
    const info = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) info.set(key, value);
    }
    return info;
  };

  // Prefer libimobiledevice when available because idevicesyslog uses iOS UDIDs
  // (xcrun devicectl "Identifier" is a CoreDevice UUID and doesn't work with idevicesyslog).
  if (hasCommand("idevice_id") && hasCommand("ideviceinfo")) {
    try {
      const udids = execSync("idevice_id -l 2>/dev/null", {
        encoding: "utf-8",
        timeout: 10000,
      })
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const devices: Device[] = [];
      for (const udid of udids) {
        let deviceName = udid;
        let model = "Unknown";
        let connectionType = "USB";

        try {
          const infoRaw = execSync(`ideviceinfo -u ${udid} -s 2>/dev/null`, {
            encoding: "utf-8",
            timeout: 10000,
          });
          const info = parseIdeviceInfo(infoRaw);
          deviceName = info.get("DeviceName") || deviceName;
          const productType = info.get("ProductType");
          const productVersion = info.get("ProductVersion");
          model = [productType, productVersion ? `(iOS ${productVersion})` : ""]
            .filter(Boolean)
            .join(" ");
          const conn = info.get("ConnectionType");
          if (conn) connectionType = conn;
        } catch {
          // best-effort; fall back to UDID-only
        }

        devices.push({ udid, name: deviceName, model, connectionType });
      }
      return devices;
    } catch {
      // fall back to devicectl
    }
  }

  try {
    const output = execSync("xcrun devicectl list devices 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10000,
    });
    
    const devices: Device[] = [];
    const lines = output.split("\n").slice(2); // Skip header lines
    
    for (const line of lines) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 4) {
        devices.push({
          name: parts[0],
          udid: parts[2],
          model: parts[4] || "Unknown",
          connectionType: parts[1] || "Unknown",
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

// Get list of iOS Simulators
function getSimulators(): Simulator[] {
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
      timeout: 10000,
    });
    
    const data = JSON.parse(output);
    const simulators: Simulator[] = [];
    
    for (const [runtime, devices] of Object.entries(data.devices)) {
      const runtimeName = runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, " ");
      for (const device of devices as Array<{ udid: string; name: string; state: string; isAvailable: boolean }>) {
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtimeName,
          isAvailable: device.isAvailable,
        });
      }
    }
    
    return simulators;
  } catch {
    return [];
  }
}

// Find simulator by name or UDID
function findSimulator(identifier: string): Simulator | undefined {
  const simulators = getSimulators();
  return simulators.find(
    (s) => s.udid === identifier || s.name.toLowerCase() === identifier.toLowerCase()
  );
}

// Find device by name or UDID
function findDevice(identifier: string): Device | undefined {
  const devices = getConnectedDevices();
  return devices.find(
    (d) => d.udid === identifier || d.name.toLowerCase() === identifier.toLowerCase()
  );
}

// Get iOS device logs using idevicesyslog or devicectl
async function getDeviceLogs(
  udid: string,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    let lineCount = 0;
    
    // Check if idevicesyslog is available (preferred for real-time)
    let hasIdevicesyslog = false;
    try {
      execSync("which idevicesyslog", { encoding: "utf-8" });
      hasIdevicesyslog = true;
    } catch {
      hasIdevicesyslog = false;
    }
    
    if (hasIdevicesyslog) {
      // Use idevicesyslog for real device logs
      const args = ["-u", udid];
      if (process) {
        args.push("-p", process); // Filter by process name
      }
      
      const child = spawn("idevicesyslog", args);
      
      child.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (lineCount < maxLines && line.trim()) {
            output += line + "\n";
            lineCount++;
          }
        }
      });
      
      child.stderr.on("data", (data: Buffer) => {
        const errMsg = data.toString();
        if (!errMsg.includes("waiting")) {
          output += `[stderr] ${errMsg}`;
        }
      });

      // Collect for a short duration since idevicesyslog is real-time
      const collectDuration = Math.min(lastMinutes * 60 * 1000, 10 * 60 * 1000); // Max 10 minutes
      setTimeout(() => {
        child.kill("SIGTERM");
        resolve(output || `No logs captured from device ${udid}`);
      }, collectDuration);
      
      child.on("error", (err) => {
        resolve(`Error: ${err.message}\n\nMake sure the device is connected and trusted.`);
      });
    } else {
      // Fallback message - suggest installing libimobiledevice
      resolve(
        `⚠️ idevicesyslog not found.\n\n` +
        `To get iOS device logs, install libimobiledevice:\n` +
        `  brew install libimobiledevice\n\n` +
        `Then ensure your device is:\n` +
        `  1. Connected via USB\n` +
        `  2. Unlocked\n` +
        `  3. Trusted (tap "Trust" on device when prompted)`
      );
    }
  });
}

// Get iOS Simulator logs
async function getSimulatorLogs(
  udid: string,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    // Simulator logs are in ~/Library/Logs/CoreSimulator/{UDID}/system.log
    // But we can also use `xcrun simctl spawn` to run log command inside simulator
    
    // First, check if simulator is booted
    const simulator = findSimulator(udid);
    if (!simulator) {
      resolve(`Simulator with identifier "${udid}" not found`);
      return;
    }
    
    if (simulator.state !== "Booted") {
      resolve(
        `Simulator "${simulator.name}" is not running (state: ${simulator.state}).\n` +
        `Boot it first with: xcrun simctl boot "${simulator.udid}"`
      );
      return;
    }
    
    // Use log command with simulator predicate
    const args = [
      "show",
      "--last", `${lastMinutes}m`,
      "--style", "compact",
      "--predicate", `subsystem CONTAINS "com.apple" AND simulatorIdentifier == "${udid}"`
    ];
    
    // Alternative: Use xcrun simctl spawn to run log inside simulator
    const spawnArgs = [
      "simctl", "spawn", udid,
      "log", "show",
      "--last", `${lastMinutes}m`,
      "--style", "compact"
    ];
    
    if (process) {
      spawnArgs.push("--predicate", `processImagePath CONTAINS "${process}"`);
    }
    
    const child = spawn("xcrun", spawnArgs);
    let output = "";
    let lineCount = 0;
    
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (lineCount < maxLines) {
          output += line + "\n";
          lineCount++;
        }
      }
    });
    
    child.stderr.on("data", (data: Buffer) => {
      output += `[stderr] ${data.toString()}`;
    });
    
    child.on("close", () => {
      resolve(output || `No logs found for simulator ${simulator.name}`);
    });
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
    
    setTimeout(() => {
      child.kill();
      resolve(output || "Timeout waiting for simulator logs");
    }, 15000);
  });
}

// Stream simulator logs in real-time
async function streamSimulatorLogs(
  udid: string,
  process?: string,
  durationSeconds: number = 10
): Promise<string> {
  return new Promise((resolve) => {
    const simulator = findSimulator(udid);
    if (!simulator) {
      resolve(`Simulator with identifier "${udid}" not found`);
      return;
    }
    
    if (simulator.state !== "Booted") {
      resolve(
        `Simulator "${simulator.name}" is not running.\n` +
        `Boot it first with: xcrun simctl boot "${simulator.udid}"`
      );
      return;
    }
    
    const spawnArgs = [
      "simctl", "spawn", udid,
      "log", "stream",
      "--style", "compact"
    ];
    
    if (process) {
      spawnArgs.push("--predicate", `processImagePath CONTAINS "${process}"`);
    }
    
    const child = spawn("xcrun", spawnArgs);
    let output = "";
    
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    setTimeout(() => {
      child.kill("SIGTERM");
      resolve(output || `No logs captured from simulator ${simulator.name}`);
    }, durationSeconds * 1000);
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// Get macOS system logs
async function getMacLogs(
  subsystem?: string,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    const args = ["show", "--last", `${lastMinutes}m`, "--style", "compact"];
    
    const predicates: string[] = [];
    if (subsystem) {
      predicates.push(`subsystem == "${subsystem}"`);
    }
    if (process) {
      predicates.push(`processImagePath CONTAINS "${process}"`);
    }
    
    if (predicates.length > 0) {
      args.push("--predicate", predicates.join(" AND "));
    }
    
    const child = spawn("log", args);
    let output = "";
    let lineCount = 0;
    
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (lineCount < maxLines) {
          output += line + "\n";
          lineCount++;
        }
      }
    });
    
    child.stderr.on("data", (data: Buffer) => {
      output += `[stderr] ${data.toString()}`;
    });
    
    child.on("close", () => {
      resolve(output || "No logs found");
    });
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
    
    setTimeout(() => {
      child.kill();
      resolve(output || "Timeout");
    }, 15000);
  });
}

// Stream logs from iOS device using idevicesyslog (if available) or log stream
async function streamDeviceLogs(
  udid: string,
  process?: string,
  durationSeconds: number = 10
): Promise<string> {
  return new Promise((resolve) => {
    // Stream macOS logs (uses `log stream`). For iOS devices use get_device_logs
    // or provide a device to stream via idevicesyslog in the tool handler.
    const args = ["stream", "--style", "compact"];
    if (process) {
      args.push("--predicate", `processImagePath CONTAINS "${process}"`);
    }

    const child = spawn("log", args);
    let output = "";
    
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    // Stop after duration
    setTimeout(() => {
      child.kill("SIGTERM");
      resolve(output || "No logs captured during stream");
    }, durationSeconds * 1000);
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

async function streamIOSDeviceLogs(
  udid: string,
  process?: string,
  durationSeconds: number = 10
): Promise<string> {
  return new Promise((resolve) => {
    let output = "";

    try {
      execSync("which idevicesyslog", { encoding: "utf-8" });
    } catch {
      resolve(
        `⚠️ idevicesyslog not found.\n\nTo stream iOS device logs:\n  brew install libimobiledevice`
      );
      return;
    }

    const args = ["-u", udid];
    if (process) args.push("-p", process);

    const child = spawn("idevicesyslog", args);

    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });

    setTimeout(() => {
      child.kill("SIGTERM");
      resolve(output || "No logs captured during stream");
    }, durationSeconds * 1000);

    child.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

// Search logs
async function searchLogs(
  query: string,
  lastMinutes: number = 30,
  maxLines: number = 100,
  useRegex: boolean = false
): Promise<string> {
  return new Promise((resolve) => {
    const args = ["show", "--last", `${lastMinutes}m`, "--style", "compact"];
    
    const child = spawn("log", args);
    let output = "";
    let lineCount = 0;
    
    let matcher: (line: string) => boolean;
    if (useRegex) {
      try {
        const regex = new RegExp(query, "i");
        matcher = (line: string) => regex.test(line);
      } catch (e) {
        resolve(`Invalid regex pattern: ${query}\nError: ${e}`);
        return;
      }
    } else {
      const queryLower = query.toLowerCase();
      matcher = (line: string) => line.toLowerCase().includes(queryLower);
    }
    
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (matcher(line) && lineCount < maxLines) {
          output += line + "\n";
          lineCount++;
        }
      }
    });
    
    child.on("close", () => {
      resolve(output || `No logs matching "${query}" found`);
    });
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
    
    setTimeout(() => {
      child.kill();
      resolve(output || "Timeout");
    }, 30000);
  });
}

// Get logs filtered by level
async function getLogsByLevel(
  level: LogLevel,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    const args = ["show", "--last", `${lastMinutes}m`, "--style", "compact"];
    
    const predicates: string[] = [];
    
    // Map log level to predicate
    // macOS log levels: fault (0), error (1), default (2), info (3), debug (4)
    switch (level) {
      case "fault":
        predicates.push("messageType == fault");
        break;
      case "error":
        predicates.push("(messageType == error OR messageType == fault)");
        break;
      case "warning":
        // Warning maps to default level with certain keywords
        predicates.push("messageType == default");
        break;
      case "info":
        predicates.push("messageType == info");
        break;
      case "debug":
        predicates.push("messageType == debug");
        args.push("--info", "--debug"); // Enable info and debug levels
        break;
      default:
        predicates.push("messageType == default");
    }
    
    if (process) {
      predicates.push(`processImagePath CONTAINS "${process}"`);
    }
    
    if (predicates.length > 0) {
      args.push("--predicate", predicates.join(" AND "));
    }
    
    const child = spawn("log", args);
    let output = "";
    let lineCount = 0;
    
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (lineCount < maxLines) {
          output += line + "\n";
          lineCount++;
        }
      }
    });
    
    child.stderr.on("data", (data: Buffer) => {
      // Ignore stderr for level filtering
    });
    
    child.on("close", () => {
      resolve(output || `No ${level} logs found`);
    });
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
    
    setTimeout(() => {
      child.kill();
      resolve(output || "Timeout");
    }, 15000);
  });
}

// Get crash logs from DiagnosticReports
async function getCrashLogs(
  process?: string,
  lastDays: number = 7,
  maxReports: number = 10
): Promise<{ reports: CrashReport[]; summary: string }> {
  const crashDirs = [
    join(homedir(), "Library/Logs/DiagnosticReports"),
    "/Library/Logs/DiagnosticReports",
  ];
  
  const reports: CrashReport[] = [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lastDays);
  
  for (const dir of crashDirs) {
    try {
      const files = await readdir(dir);
      
      for (const file of files) {
        // Crash reports have extensions like .crash, .ips, .diag
        if (!file.match(/\.(crash|ips|diag)$/)) continue;
        
        // Filter by process name if specified
        if (process && !file.toLowerCase().includes(process.toLowerCase())) {
          continue;
        }
        
        const filePath = join(dir, file);
        const fileStat = await stat(filePath);
        
        // Check if within date range
        if (fileStat.mtime < cutoffDate) continue;
        
        // Read first few lines for preview
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n").slice(0, 10);
        const preview = lines.join("\n");
        
        // Extract process name from filename (format: ProcessName-Date-Device.crash)
        const processName = file.split("-")[0] || file;
        
        reports.push({
          filename: file,
          path: filePath,
          process: processName,
          date: fileStat.mtime,
          preview,
        });
      }
    } catch {
      // Directory doesn't exist or not accessible
      continue;
    }
  }
  
  // Sort by date descending
  reports.sort((a, b) => b.date.getTime() - a.date.getTime());
  
  // Limit results
  const limitedReports = reports.slice(0, maxReports);
  
  // Create summary
  let summary = "";
  if (limitedReports.length === 0) {
    summary = process 
      ? `No crash reports found for "${process}" in the last ${lastDays} days.`
      : `No crash reports found in the last ${lastDays} days.`;
  } else {
    summary = `Found ${reports.length} crash report(s)${reports.length > maxReports ? ` (showing ${maxReports})` : ""}:\n\n`;
    summary += limitedReports.map((r, i) => 
      `${i + 1}. 💥 ${r.process}\n   File: ${r.filename}\n   Date: ${r.date.toLocaleString()}`
    ).join("\n\n");
  }
  
  return { reports: limitedReports, summary };
}

// Read a specific crash report
async function readCrashReport(filename: string): Promise<string> {
  const crashDirs = [
    join(homedir(), "Library/Logs/DiagnosticReports"),
    "/Library/Logs/DiagnosticReports",
  ];
  
  for (const dir of crashDirs) {
    try {
      const filePath = join(dir, filename);
      const content = await readFile(filePath, "utf-8");
      return content;
    } catch {
      continue;
    }
  }
  
  return `Crash report "${filename}" not found.`;
}

// Watch for a pattern and stop when found
async function watchForPattern(
  pattern: string,
  useRegex: boolean = false,
  process?: string,
  timeoutSeconds: number = 30
): Promise<{ found: boolean; matchedLine: string; allOutput: string }> {
  return new Promise((resolve) => {
    const args = ["stream", "--style", "compact"];
    
    if (process) {
      args.push("--predicate", `processImagePath CONTAINS "${process}"`);
    }
    
    const child = spawn("log", args);
    let output = "";
    let found = false;
    let matchedLine = "";
    
    let matcher: (line: string) => boolean;
    if (useRegex) {
      try {
        const regex = new RegExp(pattern, "i");
        matcher = (line: string) => regex.test(line);
      } catch (e) {
        resolve({ found: false, matchedLine: "", allOutput: `Invalid regex: ${e}` });
        return;
      }
    } else {
      const patternLower = pattern.toLowerCase();
      matcher = (line: string) => line.toLowerCase().includes(patternLower);
    }
    
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        output += line + "\n";
        if (!found && matcher(line)) {
          found = true;
          matchedLine = line;
          child.kill("SIGTERM");
        }
      }
    });
    
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    child.on("close", () => {
      resolve({ found, matchedLine, allOutput: output });
    });
    
    child.on("error", (err) => {
      resolve({ found: false, matchedLine: "", allOutput: `Error: ${err.message}` });
    });
    
    // Timeout
    setTimeout(() => {
      if (!found) {
        child.kill("SIGTERM");
        resolve({ found: false, matchedLine: "", allOutput: output + "\n\n⏱️ Timeout reached without finding pattern." });
      }
    }, timeoutSeconds * 1000);
  });
}

async function watchForPatternOnIOSDevice(
  udid: string,
  pattern: string,
  useRegex: boolean = false,
  process?: string,
  timeoutSeconds: number = 30
): Promise<{ found: boolean; matchedLine: string; allOutput: string }> {
  return new Promise((resolve) => {
    let output = "";
    let found = false;
    let matchedLine = "";

    try {
      execSync("which idevicesyslog", { encoding: "utf-8" });
    } catch {
      resolve({
        found: false,
        matchedLine: "",
        allOutput: `⚠️ idevicesyslog not found. Install with: brew install libimobiledevice`,
      });
      return;
    }

    let matcher: (line: string) => boolean;
    if (useRegex) {
      try {
        const regex = new RegExp(pattern, "i");
        matcher = (line: string) => regex.test(line);
      } catch (e) {
        resolve({ found: false, matchedLine: "", allOutput: `Invalid regex: ${e}` });
        return;
      }
    } else {
      const patternLower = pattern.toLowerCase();
      matcher = (line: string) => line.toLowerCase().includes(patternLower);
    }

    const args = ["-u", udid];
    if (process) args.push("-p", process);
    const child = spawn("idevicesyslog", args);

    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (!line) continue;
        output += line + "\n";
        if (!found && matcher(line)) {
          found = true;
          matchedLine = line;
          child.kill("SIGTERM");
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });

    child.on("close", () => {
      resolve({ found, matchedLine, allOutput: output });
    });

    child.on("error", (err) => {
      resolve({ found: false, matchedLine: "", allOutput: `Error: ${err.message}` });
    });

    setTimeout(() => {
      if (!found) child.kill("SIGTERM");
    }, timeoutSeconds * 1000);
  });
}

// Export logs to file
async function exportLogs(
  logs: string,
  filename?: string,
  format: "txt" | "json" = "txt"
): Promise<string> {
  const exportDir = join(homedir(), "Desktop", "ConsoleMCP-Exports");
  
  try {
    await mkdir(exportDir, { recursive: true });
  } catch {
    // Directory might already exist
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultFilename = `logs-${timestamp}.${format}`;
  const finalFilename = filename || defaultFilename;
  const filePath = join(exportDir, finalFilename);
  
  let content: string;
  if (format === "json") {
    const lines = logs.split("\n").filter(l => l.trim());
    content = JSON.stringify({ 
      exportedAt: new Date().toISOString(),
      lineCount: lines.length,
      logs: lines 
    }, null, 2);
  } else {
    content = `# Console MCP Log Export\n# Exported: ${new Date().toISOString()}\n\n${logs}`;
  }
  
  await writeFile(filePath, content, "utf-8");
  
  return filePath;
}

// Create the MCP server
const server = new Server(
  {
    name: "console-mcp",
    version: "1.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_devices",
        description: "List connected iOS devices (physical devices connected via USB)",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "list_simulators",
        description: "List available iOS Simulators with their state (Booted/Shutdown)",
        inputSchema: {
          type: "object",
          properties: {
            onlyBooted: {
              type: "boolean",
              description: "Only show running simulators (default: false)",
            },
            runtime: {
              type: "string",
              description: "Filter by runtime (e.g., 'iOS 17', 'iOS 18')",
            },
          },
          required: [],
        },
      },
      {
        name: "get_logs",
        description: "Get recent logs from macOS system. Use for debugging macOS apps.",
        inputSchema: {
          type: "object",
          properties: {
            process: {
              type: "string",
              description: "Filter by process name (e.g., 'WorxVPNExtension', 'Safari')",
            },
            subsystem: {
              type: "string",
              description: "Filter by subsystem (e.g., 'com.worxvpn.ios')",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to fetch (default: 5)",
            },
            maxLines: {
              type: "number",
              description: "Maximum number of log lines to return (default: 200)",
            },
          },
          required: [],
        },
      },
      {
        name: "get_device_logs",
        description: "Get logs from a connected iOS device. Requires libimobiledevice (brew install libimobiledevice)",
        inputSchema: {
          type: "object",
          properties: {
            device: {
              type: "string",
              description: "Device name or UDID (use list_devices to find)",
            },
            process: {
              type: "string",
              description: "Filter by process/app name",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to capture (default: 5, max: 10)",
            },
            maxLines: {
              type: "number",
              description: "Maximum log lines (default: 200)",
            },
          },
          required: ["device"],
        },
      },
      {
        name: "get_simulator_logs",
        description: "Get logs from an iOS Simulator. The simulator must be booted.",
        inputSchema: {
          type: "object",
          properties: {
            simulator: {
              type: "string",
              description: "Simulator name or UDID (use list_simulators to find)",
            },
            process: {
              type: "string",
              description: "Filter by process/app name",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to fetch (default: 5)",
            },
            maxLines: {
              type: "number",
              description: "Maximum log lines (default: 200)",
            },
          },
          required: ["simulator"],
        },
      },
      {
        name: "stream_logs",
        description: "Stream live logs for a specified duration. Useful for capturing logs during an action.",
        inputSchema: {
          type: "object",
          properties: {
            process: {
              type: "string",
              description: "Filter by process name",
            },
            durationSeconds: {
              type: "number",
              description: "How long to stream logs (default: 10 seconds, max: 30)",
            },
          },
          required: [],
        },
      },
      {
        name: "stream_simulator_logs",
        description: "Stream live logs from an iOS Simulator for a duration",
        inputSchema: {
          type: "object",
          properties: {
            simulator: {
              type: "string",
              description: "Simulator name or UDID",
            },
            process: {
              type: "string",
              description: "Filter by process name",
            },
            durationSeconds: {
              type: "number",
              description: "How long to stream (default: 10, max: 30)",
            },
          },
          required: ["simulator"],
        },
      },
      {
        name: "search_logs",
        description: "Search through recent logs for a specific string or regex pattern",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text or regex pattern to search for in logs",
            },
            useRegex: {
              type: "boolean",
              description: "Treat query as a regex pattern (default: false)",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to search (default: 30)",
            },
            maxLines: {
              type: "number",
              description: "Maximum matching lines to return (default: 100)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_logs_by_level",
        description: "Get logs filtered by severity level (fault, error, warning, info, debug)",
        inputSchema: {
          type: "object",
          properties: {
            level: {
              type: "string",
              enum: ["fault", "error", "warning", "info", "debug"],
              description: "Log level to filter by",
            },
            process: {
              type: "string",
              description: "Filter by process name",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to fetch (default: 5)",
            },
            maxLines: {
              type: "number",
              description: "Maximum log lines (default: 200)",
            },
          },
          required: ["level"],
        },
      },
      {
        name: "get_crash_logs",
        description: "List recent crash reports from DiagnosticReports",
        inputSchema: {
          type: "object",
          properties: {
            process: {
              type: "string",
              description: "Filter by process/app name",
            },
            lastDays: {
              type: "number",
              description: "How many days back to search (default: 7)",
            },
            maxReports: {
              type: "number",
              description: "Maximum reports to list (default: 10)",
            },
          },
          required: [],
        },
      },
      {
        name: "read_crash_report",
        description: "Read the full content of a specific crash report",
        inputSchema: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "The crash report filename (from get_crash_logs)",
            },
          },
          required: ["filename"],
        },
      },
      {
        name: "watch_for_pattern",
        description: "Stream logs until a pattern is found. Useful for test automation - start an action, then wait for a specific log message.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Text or regex pattern to watch for",
            },
            useRegex: {
              type: "boolean",
              description: "Treat pattern as regex (default: false)",
            },
            process: {
              type: "string",
              description: "Filter by process name",
            },
            timeoutSeconds: {
              type: "number",
              description: "Max seconds to wait (default: 30, max: 60)",
            },
          },
          required: ["pattern"],
        },
      },
      {
        name: "export_logs",
        description: "Export logs to a file on the Desktop for sharing",
        inputSchema: {
          type: "object",
          properties: {
            logs: {
              type: "string",
              description: "The log content to export (from a previous get_logs call)",
            },
            filename: {
              type: "string",
              description: "Optional filename (auto-generated if not provided)",
            },
            format: {
              type: "string",
              enum: ["txt", "json"],
              description: "Export format (default: txt)",
            },
          },
          required: ["logs"],
        },
      },
      {
        name: "get_vpn_logs",
        description: "Get logs specifically for WorxVPN extension - filters for VPN-related processes",
        inputSchema: {
          type: "object",
          properties: {
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to fetch (default: 5)",
            },
            maxLines: {
              type: "number",
              description: "Maximum number of log lines (default: 300)",
            },
          },
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case "list_devices": {
        const devices = getConnectedDevices();
        if (devices.length === 0) {
          return {
            content: [{ type: "text", text: "No iOS devices connected.\n\nMake sure your device is:\n1. Connected via USB\n2. Unlocked\n3. Trusted (tap 'Trust' when prompted)" }],
          };
        }
        const deviceList = devices
          .map((d) => `📱 ${d.name}\n   UDID: ${d.udid}\n   Model: ${d.model}\n   Connection: ${d.connectionType}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: `Found ${devices.length} device(s):\n\n${deviceList}` }],
        };
      }
      
      case "list_simulators": {
        const onlyBooted = args?.onlyBooted as boolean | undefined;
        const runtimeFilter = args?.runtime as string | undefined;
        
        let simulators = getSimulators();
        
        if (simulators.length === 0) {
          return {
            content: [{ type: "text", text: "No simulators found. Make sure Xcode is installed." }],
          };
        }
        
        // Filter by booted state
        if (onlyBooted) {
          simulators = simulators.filter((s) => s.state === "Booted");
        }
        
        // Filter by runtime
        if (runtimeFilter) {
          simulators = simulators.filter((s) => 
            s.runtime.toLowerCase().includes(runtimeFilter.toLowerCase())
          );
        }
        
        if (simulators.length === 0) {
          return {
            content: [{ type: "text", text: "No simulators match the filter criteria." }],
          };
        }
        
        const simList = simulators
          .map((s) => {
            const status = s.state === "Booted" ? "🟢" : "⚪";
            return `${status} ${s.name} (${s.runtime})\n   UDID: ${s.udid}\n   State: ${s.state}`;
          })
          .join("\n\n");
        
        return {
          content: [{ type: "text", text: `Found ${simulators.length} simulator(s):\n\n${simList}` }],
        };
      }
      
      case "get_logs": {
        const process = args?.process as string | undefined;
        const subsystem = args?.subsystem as string | undefined;
        const lastMinutes = (args?.lastMinutes as number) || 5;
        const maxLines = (args?.maxLines as number) || 200;
        
        const logs = await getMacLogs(subsystem, process, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      case "get_device_logs": {
        const deviceId = args?.device as string;
        const process = args?.process as string | undefined;
        const lastMinutes = Math.min((args?.lastMinutes as number) || 5, 10);
        const maxLines = (args?.maxLines as number) || 200;
        
        if (!deviceId) {
          return {
            content: [{ type: "text", text: "Error: device parameter is required. Use list_devices to find device name or UDID." }],
          };
        }
        
        const device = findDevice(deviceId);
        if (!device) {
          const devices = getConnectedDevices();
          if (devices.length === 0) {
            return {
              content: [{ type: "text", text: `Device "${deviceId}" not found. No devices are currently connected.` }],
            };
          }
          return {
            content: [{ 
              type: "text", 
              text: `Device "${deviceId}" not found.\n\nAvailable devices:\n${devices.map(d => `- ${d.name} (${d.udid})`).join("\n")}` 
            }],
          };
        }
        
        const logs = await getDeviceLogs(device.udid, process, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: `📱 Logs from ${device.name}:\n\n${logs}` }],
        };
      }
      
      case "get_simulator_logs": {
        const simulatorId = args?.simulator as string;
        const process = args?.process as string | undefined;
        const lastMinutes = (args?.lastMinutes as number) || 5;
        const maxLines = (args?.maxLines as number) || 200;
        
        if (!simulatorId) {
          return {
            content: [{ type: "text", text: "Error: simulator parameter is required. Use list_simulators to find simulator name or UDID." }],
          };
        }
        
        const simulator = findSimulator(simulatorId);
        if (!simulator) {
          const bootedSims = getSimulators().filter(s => s.state === "Booted");
          if (bootedSims.length === 0) {
            return {
              content: [{ type: "text", text: `Simulator "${simulatorId}" not found. No simulators are currently running.` }],
            };
          }
          return {
            content: [{ 
              type: "text", 
              text: `Simulator "${simulatorId}" not found.\n\nRunning simulators:\n${bootedSims.map(s => `- ${s.name} (${s.udid})`).join("\n")}` 
            }],
          };
        }
        
        const logs = await getSimulatorLogs(simulator.udid, process, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: `📱 Logs from ${simulator.name} (${simulator.runtime}):\n\n${logs}` }],
        };
      }
      
      case "stream_logs": {
        const deviceId = args?.device as string | undefined;
        const process = args?.process as string | undefined;
        const duration = Math.min((args?.durationSeconds as number) || 10, 30);

        if (deviceId) {
          const device = findDevice(deviceId);
          if (!device) {
            const devices = getConnectedDevices();
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Device "${deviceId}" not found.\n\nAvailable devices:\n` +
                    (devices.length ? devices.map((d) => `- ${d.name} (${d.udid})`).join("\n") : "(none)"),
                },
              ],
            };
          }

          const logs = await streamIOSDeviceLogs(device.udid, process, duration);
          return { content: [{ type: "text", text: `📱 Streamed logs from ${device.name}:\n\n${logs}` }] };
        }

        const logs = await streamDeviceLogs("", process, duration);
        return { content: [{ type: "text", text: logs }] };
      }
      
      case "stream_simulator_logs": {
        const simulatorId = args?.simulator as string;
        const process = args?.process as string | undefined;
        const duration = Math.min((args?.durationSeconds as number) || 10, 30);
        
        if (!simulatorId) {
          return {
            content: [{ type: "text", text: "Error: simulator parameter is required." }],
          };
        }
        
        const logs = await streamSimulatorLogs(simulatorId, process, duration);
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      case "search_logs": {
        const query = args?.query as string;
        const useRegex = args?.useRegex as boolean || false;
        const lastMinutes = (args?.lastMinutes as number) || 30;
        const maxLines = (args?.maxLines as number) || 100;
        
        if (!query) {
          return {
            content: [{ type: "text", text: "Error: query is required" }],
          };
        }
        
        const logs = await searchLogs(query, lastMinutes, maxLines, useRegex);
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      case "get_logs_by_level": {
        const level = args?.level as LogLevel;
        const process = args?.process as string | undefined;
        const lastMinutes = (args?.lastMinutes as number) || 5;
        const maxLines = (args?.maxLines as number) || 200;
        
        if (!level) {
          return {
            content: [{ type: "text", text: "Error: level is required (fault, error, warning, info, debug)" }],
          };
        }
        
        const logs = await getLogsByLevel(level, process, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: `🔍 ${level.toUpperCase()} logs:\n\n${logs}` }],
        };
      }
      
      case "get_crash_logs": {
        const process = args?.process as string | undefined;
        const lastDays = (args?.lastDays as number) || 7;
        const maxReports = (args?.maxReports as number) || 10;
        
        const { summary } = await getCrashLogs(process, lastDays, maxReports);
        return {
          content: [{ type: "text", text: summary }],
        };
      }
      
      case "read_crash_report": {
        const filename = args?.filename as string;
        
        if (!filename) {
          return {
            content: [{ type: "text", text: "Error: filename is required. Use get_crash_logs first to find crash reports." }],
          };
        }
        
        const content = await readCrashReport(filename);
        return {
          content: [{ type: "text", text: `📄 Crash Report: ${filename}\n\n${content}` }],
        };
      }
      
      case "watch_for_pattern": {
        const pattern = args?.pattern as string;
        const useRegex = args?.useRegex as boolean || false;
        const process = args?.process as string | undefined;
        const deviceId = args?.device as string | undefined;
        const timeoutSeconds = Math.min((args?.timeoutSeconds as number) || 30, 60);
        
        if (!pattern) {
          return {
            content: [{ type: "text", text: "Error: pattern is required" }],
          };
        }
        
        const result = await (deviceId
          ? (() => {
              const device = findDevice(deviceId);
              if (!device) {
                return Promise.resolve({
                  found: false,
                  matchedLine: "",
                  allOutput: `Device "${deviceId}" not found.`,
                });
              }
              return watchForPatternOnIOSDevice(
                device.udid,
                pattern,
                useRegex,
                process,
                timeoutSeconds
              );
            })()
          : watchForPattern(pattern, useRegex, process, timeoutSeconds));
        
        if (result.found) {
          return {
            content: [{ 
              type: "text", 
              text: `✅ Pattern found!\n\n🎯 Matched line:\n${result.matchedLine}\n\n📝 Full log output:\n${result.allOutput}` 
            }],
          };
        } else {
          return {
            content: [{ 
              type: "text", 
              text: `❌ Pattern "${pattern}" not found within ${timeoutSeconds} seconds.\n\n📝 Captured logs:\n${result.allOutput}` 
            }],
          };
        }
      }
      
      case "export_logs": {
        const logs = args?.logs as string;
        const filename = args?.filename as string | undefined;
        const format = (args?.format as "txt" | "json") || "txt";
        
        if (!logs) {
          return {
            content: [{ type: "text", text: "Error: logs content is required" }],
          };
        }
        
        const filePath = await exportLogs(logs, filename, format);
        return {
          content: [{ type: "text", text: `✅ Logs exported to:\n${filePath}` }],
        };
      }
      
      case "get_vpn_logs": {
        const lastMinutes = (args?.lastMinutes as number) || 5;
        const maxLines = (args?.maxLines as number) || 300;
        
        // Get logs for VPN-related processes
        const logs = await getMacLogs(
          undefined,
          "WorxVPN",
          lastMinutes,
          maxLines
        );
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error}` }],
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Console MCP server running");
}

main().catch(console.error);
