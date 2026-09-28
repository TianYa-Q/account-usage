import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Failures only; never write OAuth credentials, request headers, URLs or response bodies.
// Keep the current log and one rotated backup (roughly 2 MiB total).
const LOG_PATH = join(getAgentDir(), "account-usage-errors.jsonl");
const MAX_LOG_BYTES = 1024 * 1024;

type ErrorDetails = {
  name: string;
  message?: string;
  code?: string;
  syscall?: string;
  cause?: ErrorDetails;
  errors?: ErrorDetails[];
};

function describeError(value: unknown, depth = 0): ErrorDetails {
  if (!(value instanceof Error)) return { name: typeof value };
  const details: ErrorDetails = { name: value.name };
  // Only known, non-sensitive messages are copied. Error strings from providers
  // may contain URLs with query parameters or even credentials.
  if (
    /^(fetch failed|This operation was aborted|The operation was aborted)$/iu.test(
      value.message,
    )
  ) {
    details.message = value.message;
  }
  if (/^额度接口返回 HTTP \d{3}。$/u.test(value.message))
    details.message = value.message;
  const nodeError = value as Error & { code?: unknown; syscall?: unknown };
  if (
    typeof nodeError.code === "string" &&
    /^[A-Z0-9_]{1,50}$/u.test(nodeError.code)
  ) {
    details.code = nodeError.code;
  }
  if (
    typeof nodeError.syscall === "string" &&
    /^[a-zA-Z0-9_]{1,50}$/u.test(nodeError.syscall)
  ) {
    details.syscall = nodeError.syscall;
  }
  if (depth < 3) {
    if (value.cause !== undefined)
      details.cause = describeError(value.cause, depth + 1);
    if (value instanceof AggregateError) {
      details.errors = value.errors
        .slice(0, 4)
        .map((error: unknown) => describeError(error, depth + 1));
    }
  }
  return details;
}

export function logQuotaFailure(
  context: {
    provider: "codex" | "gemini" | "shared";
    operation: string;
    accountName?: string;
    elapsedMs: number;
  },
  error: unknown,
): void {
  try {
    mkdirSync(getAgentDir(), { recursive: true, mode: 0o700 });
    try {
      if (statSync(LOG_PATH).size >= MAX_LOG_BYTES)
        renameSync(LOG_PATH, `${LOG_PATH}.1`);
    } catch (fileError) {
      if (
        !(
          fileError instanceof Error &&
          "code" in fileError &&
          fileError.code === "ENOENT"
        )
      ) {
        throw fileError;
      }
    }
    appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...context, error: describeError(error) })}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    chmodSync(LOG_PATH, 0o600);
  } catch {
    // Diagnostics must never break quota refreshes.
  }
}
