import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface StrataToolCallEvent {
  timestamp?: string;
  event: 'tool_call_completed' | 'tool_call_failed';
  tool: string;
  duration_ms: number;
  cache_hit?: boolean;
  input: Record<string, any>;
  metrics?: {
    bytes_out?: number;
    lines_out?: number;
    items_found?: number;
  };
  status: 'success' | 'error';
  error?: {
    code?: string;
    message: string;
    stack?: string;
  };
}

export class StrataTelemetry {
  private static readonly MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
  private static readonly SLOW_EXECUTION_THRESHOLD_MS = 250;

  /**
   * Resolves the log file path inside the active workspace's .strata directory.
   */
  public static getLogPath(workspaceRoot: string = process.cwd()): string {
    return join(workspaceRoot, '.strata', 'strata.log');
  }

  /**
   * Records a tool call event to both stderr (dual-sink) and .strata/strata.log.
   */
  public static recordToolCall(
    event: StrataToolCallEvent,
    workspaceRoot: string = process.cwd()
  ): void {
    const payload: StrataToolCallEvent = {
      timestamp: event.timestamp || new Date().toISOString(),
      ...event,
    };

    const jsonLine = JSON.stringify(payload);

    // Sink 1: Live stderr stream for operator monitoring (slow queries & failures)
    if (payload.status === 'error') {
      process.stderr.write(`[strata-telemetry ERROR] ${jsonLine}\n`);
    } else if (payload.duration_ms >= this.SLOW_EXECUTION_THRESHOLD_MS) {
      process.stderr.write(`[strata-telemetry SLOW_WARN] ${jsonLine}\n`);
    }

    // Sink 2: Append-only persistent file recorder in .strata/strata.log
    try {
      const logPath = this.getLogPath(workspaceRoot);
      const logDir = dirname(logPath);

      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      // Check for rotation if file exceeds 2MB
      if (existsSync(logPath)) {
        try {
          const stats = statSync(logPath);
          if (stats.size >= this.MAX_LOG_SIZE_BYTES) {
            const rotatedPath = `${logPath}.1`;
            renameSync(logPath, rotatedPath);
          }
        } catch {
          // If stat/rotation fails, proceed to append without crashing
        }
      }

      appendFileSync(logPath, `${jsonLine}\n`, 'utf8');
    } catch {
      // Telemetry file writes must never crash the main application process
    }
  }
}
