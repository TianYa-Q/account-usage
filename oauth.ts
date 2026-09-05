import type {
  AuthEvent,
  AuthPrompt,
  OAuthAuth,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function getCodexOAuth(): OAuthAuth {
  const oauth = builtinProviders().find(
    (provider) => provider.id === "openai-codex",
  )?.auth.oauth;
  if (!oauth) throw new Error("Pi 内置的 OpenAI Codex OAuth 不可用。");
  return oauth;
}

export async function loginCodexAccount(
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  return getCodexOAuth().login(createOAuthInteraction(ctx, signal));
}

function createOAuthInteraction(
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): ProviderAuthInteraction {
  return {
    signal,
    prompt: (prompt) => promptForOAuth(ctx, prompt, signal),
    notify: (event) => notifyOAuthEvent(ctx, event),
  };
}

async function promptForOAuth(
  ctx: ExtensionCommandContext,
  prompt: AuthPrompt,
  ownerSignal: AbortSignal,
): Promise<string> {
  const signal = prompt.signal
    ? AbortSignal.any([ownerSignal, prompt.signal])
    : ownerSignal;
  if (prompt.type === "select") {
    const selected = await ctx.ui.select(
      prompt.message,
      prompt.options.map((option) => option.label),
      { signal },
    );
    const value = prompt.options.find(
      (option) => option.label === selected,
    )?.id;
    if (!value) throw new Error("登录已取消。");
    return value;
  }

  const value = await ctx.ui.input(prompt.message, prompt.placeholder ?? "", {
    signal,
  });
  if (value === undefined) throw new Error("登录已取消。");
  return value;
}

function notifyOAuthEvent(
  ctx: ExtensionCommandContext,
  event: AuthEvent,
): void {
  switch (event.type) {
    case "auth_url":
      ctx.ui.notify(
        ["请在浏览器中完成 OpenAI 登录：", event.url, event.instructions]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
      break;
    case "device_code":
      ctx.ui.notify(
        [
          "请打开以下地址并输入设备码：",
          event.verificationUri,
          `设备码：${event.userCode}`,
        ].join("\n"),
        "info",
      );
      break;
    case "info":
      ctx.ui.notify(
        [event.message, ...(event.links ?? []).map((link) => link.url)].join(
          "\n",
        ),
        "info",
      );
      break;
    case "progress":
      ctx.ui.notify(event.message, "info");
      break;
  }
}
