import type { OAuthCredential } from "@earendil-works/pi-ai";
import { getCodexOAuth } from "./oauth.js";
import { refreshStoredCredential } from "./store.js";
import type { AccountUsage, CodexAccount, UsageWindow } from "./types.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_SKEW_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1_024;

export async function queryAccountUsage(
  account: CodexAccount,
  signal: AbortSignal,
): Promise<AccountUsage> {
  try {
    let credential = await ensureFreshCredential(
      account.name,
      account.credential,
      signal,
    );
    try {
      return await requestUsage(account.name, credential, signal);
    } catch (error) {
      if (!(error instanceof HttpStatusError) || error.status !== 401)
        throw error;
      credential = await refreshCredential(account.name, credential, signal);
      return await requestUsage(account.name, credential, signal);
    }
  } catch (error) {
    return {
      accountName: account.name,
      capturedAt: Date.now(),
      primary: undefined,
      secondary: undefined,
      error: safeErrorMessage(error),
    };
  }
}

async function ensureFreshCredential(
  accountName: string,
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  return credential.expires > Date.now() + REFRESH_SKEW_MS
    ? credential
    : refreshCredential(accountName, credential, signal);
}

async function refreshCredential(
  accountName: string,
  _credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  return refreshStoredCredential(accountName, async (latest) => {
    signal.throwIfAborted();
    const refreshed = await getCodexOAuth().refresh(latest, signal);
    signal.throwIfAborted();
    return refreshed;
  });
}

async function requestUsage(
  accountName: string,
  credential: OAuthCredential,
  ownerSignal: AbortSignal,
): Promise<AccountUsage> {
  const accountId = resolveAccountId(credential);
  if (!accountId) throw new Error("OAuth 凭据缺少 ChatGPT account ID。");

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (ownerSignal.aborted) controller.abort();
  else ownerSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "chatgpt-account-id": accountId,
        "User-Agent": "pi-codex-account-usage",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        `额度接口返回 HTTP ${response.status}。`,
      );
    }
    const body = await readBoundedJson(response);
    const rateLimit = asRecord(body.rate_limit);
    if (!rateLimit) throw new Error("额度接口缺少 rate_limit 数据。");
    const primary = parseWindow(rateLimit.primary_window);
    const secondary = parseWindow(rateLimit.secondary_window);
    if (!primary && !secondary)
      throw new Error("额度接口没有可显示的时间窗口。");
    return {
      accountName,
      capturedAt: Date.now(),
      primary,
      secondary,
      error: undefined,
    };
  } finally {
    clearTimeout(timeout);
    ownerSignal.removeEventListener("abort", abort);
  }
}

async function readBoundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES)
    throw new Error("额度响应过大。");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
    throw new Error("额度响应过大。");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("额度接口返回了无效 JSON。");
  }
  const record = asRecord(value);
  if (!record) throw new Error("额度接口返回结构无效。");
  return record;
}

function parseWindow(value: unknown): UsageWindow | undefined {
  const window = asRecord(value);
  if (!window) return undefined;
  const usedPercent = finiteNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const resetAt = finiteNumber(window.reset_at);
  const windowSeconds = finiteNumber(window.limit_window_seconds);
  return {
    remainingPercent: 100 - Math.min(100, Math.max(0, usedPercent)),
    resetAt: resetAt !== undefined && resetAt > 0 ? resetAt : undefined,
    windowSeconds:
      windowSeconds !== undefined && windowSeconds > 0
        ? windowSeconds
        : undefined,
  };
}

function resolveAccountId(credential: OAuthCredential): string | undefined {
  const value = credential as OAuthCredential & { accountId?: unknown };
  if (typeof value.accountId === "string" && value.accountId)
    return value.accountId;
  const payload = decodeJwtPayload(credential.access);
  const auth = asRecord(payload?.["https://api.openai.com/auth"]);
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return asRecord(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown,
    );
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError")
    return "刷新已取消";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]").slice(0, 200);
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
