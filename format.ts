import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AccountUsage, UsageWindow } from "./types.js";

export function formatStatusSegment(
  usage: AccountUsage,
  activeAccount: string | undefined,
  theme: Theme,
  now = Date.now(),
): string {
  const isActive = usage.accountName === activeAccount;
  const account = isActive
    ? theme.fg("accent", theme.bold(`› ${usage.accountName}`))
    : usage.accountName;
  if (usage.error) return `${account}  ${theme.fg("error", "查询失败")}`;

  const windows = [usage.primary, usage.secondary]
    .filter((window): window is UsageWindow => window !== undefined)
    .map((window) => formatStatusWindow(window, theme, now));
  return `${account}  ${windows.join(" · ")}`;
}

export function formatUsageSummary(
  usages: readonly AccountUsage[],
  activeAccount: string | undefined,
  now = Date.now(),
): string {
  if (usages.length === 0) return "没有可显示的 Codex 账户。";
  return usages
    .map((usage) => {
      const marker = usage.accountName === activeAccount ? "当前" : "账户";
      if (usage.error) return `${marker} ${usage.accountName}：${usage.error}`;
      const windows = [usage.primary, usage.secondary]
        .filter((window): window is UsageWindow => window !== undefined)
        .map((window) => formatWindow(window, now));
      return `${marker} ${usage.accountName}：${windows.join(" · ")}`;
    })
    .join("\n");
}

function formatStatusWindow(
  window: UsageWindow,
  theme: Theme,
  now: number,
): string {
  const percentage = Math.round(window.remainingPercent);
  const color =
    percentage < 20 ? "error" : percentage < 50 ? "warning" : "success";
  const remaining = theme.fg(color, `${percentage}%`);
  const reset = window.resetAt
    ? formatDuration(window.resetAt * 1_000 - now)
    : "未知";
  return `${remaining} (${reset})`;
}

function formatWindow(window: UsageWindow, now: number): string {
  const label = formatWindowLabel(window.windowSeconds);
  const remaining = `${Math.round(window.remainingPercent)}%`;
  const reset = window.resetAt
    ? `↻ ${formatDuration(window.resetAt * 1_000 - now)}`
    : "↻ 未知";
  return `${label} ${remaining} ${reset}`;
}

function formatWindowLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "额度";
  if (seconds <= 6 * 60 * 60) return `${Math.round(seconds / 3_600)}h`;
  if (seconds <= 8 * 24 * 60 * 60) return "7d";
  return `${Math.round(seconds / 86_400)}d`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return "现在";
  const minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0)
    return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  return `${remainingMinutes}m`;
}
