import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { fetchAccountUsage } from "./antigravity-runtime.js";

export type AntigravityUsageState =
  | { kind: "unconfigured" }
  | { kind: "loaded"; usage: AntigravityUsage }
  | { kind: "failed"; error: string };

type AntigravityUsage = {
  groups: Array<{
    displayName: string;
    buckets: Array<{
      displayName: string;
      remainingFraction: number;
      resetTime: string | undefined;
      window: string | undefined;
    }>;
  }>;
  models: Array<{
    modelId: string;
    remainingFraction: number | undefined;
    resetTime: string | undefined;
  }>;
};

export async function queryAntigravityUsage(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<AntigravityUsageState> {
  try {
    signal.throwIfAborted();
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
    if (!apiKey) return { kind: "unconfigured" };

    const usage = parseUsage(await fetchAccountUsage(apiKey));
    signal.throwIfAborted();
    return { kind: "loaded", usage };
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: "failed", error: safeErrorMessage(error) };
  }
}

export type AntigravityGUIStatus = {
  kind: "unconfigured" | "loaded" | "failed";
  isActive: boolean;
  quotas: Array<{
    remainingPercent: number;
    resetAt: number | undefined;
    window: string | undefined;
  }>;
  error: string | undefined;
};

export function antigravityGUIStatus(
  state: AntigravityUsageState,
  isActive: boolean,
): AntigravityGUIStatus {
  if (state.kind === "unconfigured") {
    return { kind: "unconfigured", isActive, quotas: [], error: undefined };
  }
  if (state.kind === "failed") {
    return { kind: "failed", isActive, quotas: [], error: state.error };
  }
  return {
    kind: "loaded",
    isActive,
    quotas: collectGeminiQuotas(state.usage).map((quota) => ({
      remainingPercent: Math.round(quota.remainingFraction * 1_000) / 10,
      resetAt: quota.resetTime
        ? finiteTimestamp(Date.parse(quota.resetTime))
        : undefined,
      window: quota.window,
    })),
    error: undefined,
  };
}

export function formatAntigravityStatus(
  state: AntigravityUsageState,
  isActive: boolean,
  theme: Theme,
  now = Date.now(),
): string | undefined {
  if (state.kind === "unconfigured") return undefined;
  const label = isActive
    ? theme.fg("accent", theme.bold("› Gemini"))
    : "Gemini";
  if (state.kind === "failed") {
    return `${label} ${theme.fg("error", "查询失败")}`;
  }

  const quotas = collectGeminiQuotas(state.usage);
  if (quotas.length === 0) {
    return `${label} ${theme.fg("warning", "无额度数据")}`;
  }

  return `${label} ${quotas
    .map((quota) => formatQuota(quota, theme, now))
    .join(" · ")}`;
}

type DisplayQuota = {
  remainingFraction: number;
  resetTime: string | undefined;
  window: string | undefined;
};

function collectGeminiQuotas(usage: AntigravityUsage): DisplayQuota[] {
  const grouped = usage.groups
    .filter((group) => /gemini/iu.test(group.displayName))
    .flatMap((group) =>
      group.buckets.map((bucket) => ({
        remainingFraction: bucket.remainingFraction,
        resetTime: bucket.resetTime,
        window: `${bucket.window ?? ""} ${bucket.displayName}`.trim(),
      })),
    );
  if (grouped.length > 0) return grouped.sort(compareQuotaWindows);

  const unique = new Map<string, DisplayQuota>();
  for (const model of usage.models) {
    if (
      !/gemini/iu.test(model.modelId) ||
      model.remainingFraction === undefined
    ) {
      continue;
    }
    const key = `${model.remainingFraction}\u0000${model.resetTime ?? ""}`;
    unique.set(key, {
      remainingFraction: model.remainingFraction,
      resetTime: model.resetTime,
      window: undefined,
    });
  }
  return [...unique.values()].sort(compareQuotaWindows);
}

function compareQuotaWindows(left: DisplayQuota, right: DisplayQuota): number {
  const rankDifference =
    quotaWindowRank(left.window) - quotaWindowRank(right.window);
  if (rankDifference !== 0) return rankDifference;
  return resetTimestamp(left.resetTime) - resetTimestamp(right.resetTime);
}

function quotaWindowRank(window: string | undefined): number {
  if (window && /(?:5\s*h|5\s*hour|five.?hour)/iu.test(window)) return 0;
  if (window && /(?:7\s*d|week)/iu.test(window)) return 1;
  return 2;
}

function finiteTimestamp(timestamp: number): number | undefined {
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function resetTimestamp(resetTime: string | undefined): number {
  if (!resetTime) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(resetTime);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function formatQuota(quota: DisplayQuota, theme: Theme, now: number): string {
  const percentage = Math.round(quota.remainingFraction * 1_000) / 10;
  const color =
    percentage < 20 ? "error" : percentage < 50 ? "warning" : "success";
  const remaining = theme.fg(color, `${percentage}%`);
  const reset = quota.resetTime
    ? formatDuration(Date.parse(quota.resetTime) - now)
    : "未知";
  return `${remaining} (${reset})`;
}

/** pi-antigravity 是外部包，额度响应在扩展边界一次性校验后再进入内部状态。 */
function parseUsage(value: unknown): AntigravityUsage {
  const usage = requireRecord(value, "Antigravity 额度响应");
  if (!Array.isArray(usage.groups) || !Array.isArray(usage.models)) {
    throw new Error("Antigravity 额度响应缺少 groups 或 models。");
  }

  return {
    groups: usage.groups.map((groupValue) => {
      const group = requireRecord(groupValue, "Antigravity 额度组");
      if (
        typeof group.displayName !== "string" ||
        !Array.isArray(group.buckets)
      ) {
        throw new Error("Antigravity 额度组结构无效。");
      }
      return {
        displayName: group.displayName,
        buckets: group.buckets.map((bucketValue) => {
          const bucket = requireRecord(bucketValue, "Antigravity 额度窗口");
          if (
            typeof bucket.displayName !== "string" ||
            !isFraction(bucket.remainingFraction)
          ) {
            throw new Error("Antigravity 额度窗口结构无效。");
          }
          return {
            displayName: bucket.displayName,
            remainingFraction: bucket.remainingFraction,
            resetTime: optionalString(bucket.resetTime, "额度窗口 resetTime"),
            window: optionalString(bucket.window, "额度窗口 window"),
          };
        }),
      };
    }),
    models: usage.models.map((modelValue) => {
      const model = requireRecord(modelValue, "Antigravity 模型额度");
      const remainingFraction = model.remainingFraction;
      if (
        typeof model.modelId !== "string" ||
        (remainingFraction !== undefined && !isFraction(remainingFraction))
      ) {
        throw new Error("Antigravity 模型额度结构无效。");
      }
      return {
        modelId: model.modelId,
        remainingFraction,
        resetTime: optionalString(model.resetTime, "模型额度 resetTime"),
      };
    }),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}结构无效。`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串。`);
  return value;
}

function isFraction(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "未知";
  if (milliseconds <= 0) return "现在";
  const minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) {
    return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  }
  return `${remainingMinutes}m`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]").slice(0, 200);
}
