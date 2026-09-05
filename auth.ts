import {
  cleanupSessionResources,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodexOAuth } from "./oauth.js";
import { readCodexAccountState, refreshStoredCredential } from "./store.js";

const PROVIDER_ID = "openai-codex";
const RUNTIME_AUTH_SELECTOR = "codex-account-manager";
const REFRESH_SKEW_MS = 5 * 60 * 1_000;

type RuntimeAuthStorage = {
  setRuntimeApiKey(providerId: string, apiKey: string): void | Promise<void>;
  removeRuntimeApiKey(providerId: string): void | Promise<void>;
};

type ProviderConfig = Parameters<
  ExtensionContext["modelRegistry"]["registerProvider"]
>[1];

/**
 * 为当前 Pi 进程应用会话绑定的 Codex 凭据。
 * 每个 Pi 进程拥有独立的运行时凭据，因此旧会话不会被其他进程中的全局账户切换影响。
 */
export class CodexSessionAuth {
  private previousProviderConfig: ProviderConfig | undefined;
  private ownsProviderOverlay = false;
  private appliedAccessToken: string | undefined;

  async activate(
    ctx: ExtensionContext,
    accountName: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const credential = await this.readFreshCredential(accountName, signal);
    if (credential.access === this.appliedAccessToken) {
      const resolved =
        await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (resolved === credential.access) return;
    }

    const runtime = getRuntimeAuthStorage(ctx);
    if (!runtime) {
      throw new Error("当前 Pi 版本不支持运行时切换 Codex 凭据。");
    }

    if (!this.ownsProviderOverlay) {
      this.previousProviderConfig =
        ctx.modelRegistry.getRegisteredProviderConfig(PROVIDER_ID);
      ctx.modelRegistry.registerProvider(PROVIDER_ID, {
        apiKey: RUNTIME_AUTH_SELECTOR,
      });
      this.ownsProviderOverlay = true;
    }

    await runtime.setRuntimeApiKey(PROVIDER_ID, credential.access);
    const resolved = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    if (resolved !== credential.access) {
      throw new Error(`Pi 未能应用 Codex 账户 ${accountName} 的运行时凭据。`);
    }

    await cleanupSessionResources(ctx.sessionManager.getSessionId());
    this.appliedAccessToken = credential.access;
  }

  async clear(ctx: ExtensionContext): Promise<void> {
    const runtime = getRuntimeAuthStorage(ctx);
    if (runtime) await runtime.removeRuntimeApiKey(PROVIDER_ID);

    if (this.ownsProviderOverlay) {
      ctx.modelRegistry.unregisterProvider(PROVIDER_ID);
      if (this.previousProviderConfig) {
        ctx.modelRegistry.registerProvider(
          PROVIDER_ID,
          this.previousProviderConfig,
        );
      }
    }

    this.previousProviderConfig = undefined;
    this.ownsProviderOverlay = false;
    this.appliedAccessToken = undefined;
  }

  private async readFreshCredential(
    accountName: string,
    signal: AbortSignal,
  ): Promise<OAuthCredential> {
    const account = readCodexAccountState().accounts.find(
      (candidate) => candidate.name === accountName,
    );
    if (!account) throw new Error(`Codex 账户 ${accountName} 不存在。`);
    if (account.credential.expires > Date.now() + REFRESH_SKEW_MS) {
      return account.credential;
    }

    return refreshStoredCredential(accountName, async (latest) => {
      signal.throwIfAborted();
      const refreshed = await getCodexOAuth().refresh(latest, signal);
      signal.throwIfAborted();
      return refreshed;
    });
  }
}

function getRuntimeAuthStorage(
  ctx: ExtensionContext,
): RuntimeAuthStorage | undefined {
  const registry = ctx.modelRegistry as unknown as {
    runtime?: unknown;
    authStorage?: unknown;
  };
  for (const candidate of [registry, registry.runtime, registry.authStorage]) {
    if (isRuntimeAuthStorage(candidate)) return candidate;
  }
  return undefined;
}

function isRuntimeAuthStorage(value: unknown): value is RuntimeAuthStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    "setRuntimeApiKey" in value &&
    typeof value.setRuntimeApiKey === "function" &&
    "removeRuntimeApiKey" in value &&
    typeof value.removeRuntimeApiKey === "function"
  );
}
