import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import { CodexSessionAuth } from "./auth.js";
import { queryAccountUsage } from "./codex.js";
import { formatStatusSegment, formatUsageSummary } from "./format.js";
import { loginCodexAccount } from "./oauth.js";
import {
  readCodexAccountState,
  readSettings,
  removeAccount,
  saveAccount,
  setActiveAccount,
  writeSettings,
} from "./store.js";
import type {
  AccountUsage,
  CodexAccount,
  CodexAccountState,
  UsageSettings,
} from "./types.js";

const STATUS_KEY = "codex-accounts";
const SELECTION_ENTRY_TYPE = "codex-account-selection";
const LEGACY_SELECTION_ENTRY_TYPE = "pi-accounts-selection";
const MODEL_HANDOFF_ENTRY_TYPE = "model-handoff-on-new-session";
const PROVIDER_ID = "openai-codex";
const QUERY_INTERVAL_MS = 60 * 1_000;
const COUNTDOWN_INTERVAL_MS = 60 * 1_000;
const QUERY_CONCURRENCY = 2;

type SelectionEntryData = {
  version: 1;
  sessionId: string;
  accountName: string;
};

export default function codexAccountExtension(pi: ExtensionAPI) {
  let settings: UsageSettings = { version: 1, hiddenAccounts: [] };
  let usages = new Map<string, AccountUsage>();
  let sessionActive = false;
  let sessionAccount: string | undefined;
  let authFailed = false;
  let sessionController: AbortController | undefined;
  let queryController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  const sessionAuth = new CodexSessionAuth();

  const publishStatus = (ctx: ExtensionContext) => {
    const state = safeReadAccountState(ctx);
    if (!state) return;
    const visibleNames = new Set(
      visibleAccounts(state.accounts, settings).map((account) => account.name),
    );
    const visibleUsages = [...usages.values()].filter((usage) =>
      visibleNames.has(usage.accountName),
    );
    const segments = sortUsages(visibleUsages, sessionAccount).map((usage) =>
      formatStatusSegment(usage, sessionAccount, ctx.ui.theme),
    );
    ctx.ui.setStatus(
      STATUS_KEY,
      segments.length > 0 ? segments.join("  │  ") : undefined,
    );
  };

  const scheduleRefresh = (ctx: ExtensionContext) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (sessionActive) void refreshAll(ctx, false);
    }, QUERY_INTERVAL_MS);
    refreshTimer.unref?.();
  };

  // 多账户查询需要限制并发、隔离单个账户失败，并防止旧会话结果覆盖新会话状态。
  const refreshAll = async (ctx: ExtensionContext, notify: boolean) => {
    const state = safeReadAccountState(ctx);
    if (!state) return;
    const visible = visibleAccounts(state.accounts, settings);
    const currentGeneration = ++generation;
    queryController?.abort();
    const controller = new AbortController();
    queryController = controller;

    if (visible.length === 0) {
      usages.clear();
      publishStatus(ctx);
      if (notify) ctx.ui.notify("没有可显示的 Codex 账户。", "info");
      scheduleRefresh(ctx);
      return;
    }

    const results = await mapWithConcurrency(
      visible,
      QUERY_CONCURRENCY,
      (account) => queryAccountUsage(account, controller.signal),
    );
    if (
      !sessionActive ||
      controller.signal.aborted ||
      currentGeneration !== generation
    ) {
      return;
    }

    usages = new Map(results.map((usage) => [usage.accountName, usage]));
    publishStatus(ctx);
    scheduleRefresh(ctx);
    if (notify) {
      ctx.ui.notify(
        formatUsageSummary(sortUsages(results, sessionAccount), sessionAccount),
        "info",
      );
    }
  };

  const activateForSession = async (
    ctx: ExtensionContext,
    accountName: string,
  ) => {
    const signal = sessionController?.signal;
    if (!signal) throw new Error("Codex 会话尚未初始化。");
    try {
      await sessionAuth.activate(ctx, accountName, signal);
      authFailed = false;
    } catch (error) {
      authFailed = true;
      throw error;
    }
  };

  const switchAccount = async (
    ctx: ExtensionCommandContext,
    accountName: string,
  ) => {
    await activateForSession(ctx, accountName);
    await setActiveAccount(accountName);
    persistSessionSelection(pi, ctx, accountName);
    sessionAccount = accountName;
    publishStatus(ctx);
    await refreshAll(ctx, false);
    ctx.ui.notify(
      `已切换到 ${accountName}。当前会话和之后的新会话将使用该账户；其他旧会话保持不变。`,
      "info",
    );
  };

  const loginAccount = async (ctx: ExtensionCommandContext) => {
    const input = await ctx.ui.input(
      "新 Codex 账户名称",
      "仅允许字母、数字、点、下划线和连字符",
    );
    if (input === undefined) return;
    const accountName = input.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(accountName)) {
      ctx.ui.notify("账户名称格式无效。", "error");
      return;
    }

    const existing = readCodexAccountState().accounts.some(
      (account) => account.name === accountName,
    );
    if (
      existing &&
      !(await ctx.ui.confirm(
        "覆盖账户",
        `账户 ${accountName} 已存在，是否重新登录并覆盖？`,
      ))
    ) {
      return;
    }

    const controller = new AbortController();
    try {
      const credential = await loginCodexAccount(ctx, controller.signal);
      await saveAccount(accountName, credential);
      await activateForSession(ctx, accountName);
      await setActiveAccount(accountName);
      persistSessionSelection(pi, ctx, accountName);
      sessionAccount = accountName;
      settings = {
        version: 1,
        hiddenAccounts: settings.hiddenAccounts.filter(
          (name) => name !== accountName,
        ),
      };
      writeSettings(settings);
      await refreshAll(ctx, false);
      ctx.ui.notify(
        `账户 ${accountName} 已登录，并设为当前及后续新会话的默认账户。`,
        "info",
      );
    } finally {
      controller.abort();
    }
  };

  const deleteAccount = async (ctx: ExtensionCommandContext) => {
    const state = readCodexAccountState();
    const removable = state.accounts.filter(
      (account) =>
        account.name !== state.activeAccount && account.name !== sessionAccount,
    );
    if (removable.length === 0) {
      ctx.ui.notify("没有可删除的账户；请先切换当前默认账户。", "warning");
      return;
    }
    const selected = await ctx.ui.select(
      "选择要删除的 Codex 账户",
      removable.map((account) => account.name),
    );
    if (!selected) return;
    if (
      !(await ctx.ui.confirm(
        "删除账户",
        `确定删除账户 ${selected}？仍在使用它的旧会话之后将无法继续请求。`,
      ))
    ) {
      return;
    }
    await removeAccount(selected);
    usages.delete(selected);
    settings = {
      version: 1,
      hiddenAccounts: settings.hiddenAccounts.filter(
        (name) => name !== selected,
      ),
    };
    writeSettings(settings);
    publishStatus(ctx);
    ctx.ui.notify(`账户 ${selected} 已删除。`, "info");
  };

  const openAccountsMenu = async (ctx: ExtensionCommandContext) => {
    while (true) {
      const state = safeReadAccountState(ctx);
      if (!state) return;
      const accountLines = state.accounts.map((account) => {
        const markers = [
          account.name === sessionAccount ? "当前会话" : undefined,
          account.name === state.activeAccount ? "新会话默认" : undefined,
        ].filter(Boolean);
        return `${account.name}${markers.length > 0 ? `（${markers.join("、")}）` : ""}`;
      });
      const action = await ctx.ui.select(
        [
          "Codex 多账户管理",
          "",
          ...(accountLines.length > 0 ? accountLines : ["尚未登录账户"]),
        ].join("\n"),
        [
          "切换账户",
          "刷新额度",
          "登录新账户",
          "删除账户",
          "额度显示设置",
          "关闭",
        ],
      );
      if (!action || action === "关闭") return;
      if (action === "切换账户") {
        if (state.accounts.length === 0) {
          ctx.ui.notify("请先登录一个账户。", "warning");
          continue;
        }
        const selected = await ctx.ui.select(
          "选择 Codex 账户",
          state.accounts.map((account) =>
            account.name === sessionAccount
              ? `✓ ${account.name}`
              : account.name,
          ),
        );
        if (selected) await switchAccount(ctx, selected.replace(/^✓\s+/u, ""));
      }
      if (action === "刷新额度") await refreshAll(ctx, true);
      if (action === "登录新账户") await loginAccount(ctx);
      if (action === "删除账户") await deleteAccount(ctx);
      if (action === "额度显示设置") await openVisibilitySettings(ctx);
    }
  };

  const openVisibilitySettings = async (ctx: ExtensionCommandContext) => {
    const state = safeReadAccountState(ctx);
    if (!state || state.accounts.length === 0) return;
    const hidden = new Set(settings.hiddenAccounts);

    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const items: SettingItem[] = state.accounts.map((account) => ({
        id: account.name,
        label: account.name,
        ...(account.name === sessionAccount
          ? { description: "当前会话正在使用" }
          : {}),
        currentValue: hidden.has(account.name) ? "隐藏" : "显示",
        values: ["显示", "隐藏"],
      }));
      const container = new Container();
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Codex 账户额度显示设置")),
          1,
          1,
        ),
      );
      const list = new SettingsList(
        items,
        Math.min(items.length + 2, 12),
        getSettingsListTheme(),
        (id, value) => {
          if (value === "隐藏") hidden.add(id);
          else hidden.delete(id);
          settings = { version: 1, hiddenAccounts: [...hidden].sort() };
          try {
            writeSettings(settings);
            usages.delete(id);
            publishStatus(ctx);
          } catch (error) {
            ctx.ui.notify(errorMessage(error), "error");
          }
          tui.requestRender();
        },
        () => done(undefined),
      );
      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ 选择 · ←→ 切换 · Esc 关闭"), 1, 0),
      );
      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
    await refreshAll(ctx, false);
  };

  pi.registerCommand("accounts", {
    description: "管理、登录和切换 OpenAI Codex 账户",
    handler: async (_args, ctx) => openAccountsMenu(ctx),
  });

  pi.registerCommand("usage", {
    description: "查看全部可见 Codex 账户的剩余额度和重置时间",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "refresh") {
        await refreshAll(ctx, true);
        return;
      }
      if (action === "settings") {
        await openVisibilitySettings(ctx);
        return;
      }
      if (action === "show") {
        await refreshAll(ctx, false);
        ctx.ui.notify(
          formatUsageSummary(
            sortUsages([...usages.values()], sessionAccount),
            sessionAccount,
          ),
          "info",
        );
        return;
      }
      if (action) {
        ctx.ui.notify("用法：/usage [refresh|settings|show]", "warning");
        return;
      }
      await refreshAll(ctx, false);
      ctx.ui.notify(
        formatUsageSummary(
          sortUsages([...usages.values()], sessionAccount),
          sessionAccount,
        ),
        "info",
      );
    },
  });

  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "new" || !ctx.model) return;
    pi.appendEntry(MODEL_HANDOFF_ENTRY_TYPE, {
      provider: ctx.model.provider,
      modelId: ctx.model.id,
    });
  });

  pi.on("session_start", async (event, ctx) => {
    sessionActive = true;
    authFailed = false;
    sessionController = new AbortController();
    try {
      settings = readSettings();
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      settings = { version: 1, hiddenAccounts: [] };
    }

    const state = safeReadAccountState(ctx);
    if (state) {
      try {
        sessionAccount = restoreSessionAccount(ctx, state);
        if (sessionAccount) {
          persistSessionSelection(pi, ctx, sessionAccount);
          await activateForSession(ctx, sessionAccount);
        } else {
          authFailed = true;
          ctx.ui.notify(
            "尚未配置 Codex 账户，请运行 /accounts 登录。",
            "warning",
          );
        }
      } catch (error) {
        sessionAccount = undefined;
        authFailed = true;
        ctx.ui.notify(errorMessage(error), "error");
      }
    } else {
      sessionAccount = undefined;
      authFailed = true;
    }

    await restoreModelForNewSession(pi, event, ctx);

    countdownTimer = setInterval(
      () => publishStatus(ctx),
      COUNTDOWN_INTERVAL_MS,
    );
    countdownTimer.unref?.();
    await refreshAll(ctx, false);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    if (!sessionAccount) {
      authFailed = true;
      ctx.ui.notify("没有可用的 Codex 账户，请运行 /accounts。", "error");
      return;
    }
    try {
      await activateForSession(ctx, sessionAccount);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.model?.provider === PROVIDER_ID && authFailed) ctx.abort();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refreshAll(ctx, false);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionActive = false;
    generation += 1;
    sessionController?.abort();
    sessionController = undefined;
    queryController?.abort();
    queryController = undefined;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = undefined;
    await sessionAuth.clear(ctx);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

// /new 前把当前模型写入旧会话，新会话完成账户认证后再恢复；启动和 /resume 均不介入。
async function restoreModelForNewSession(
  pi: ExtensionAPI,
  event: SessionStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (event.reason !== "new" || !event.previousSessionFile) return;

  let entries;
  try {
    entries = SessionManager.open(event.previousSessionFile).getBranch();
  } catch (error) {
    ctx.ui.notify(`读取上一个会话模型失败：${errorMessage(error)}`, "warning");
    return;
  }

  const handoff = [...entries].reverse().find(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === MODEL_HANDOFF_ENTRY_TYPE,
  );
  const data = handoff?.type === "custom" ? asRecord(handoff.data) : undefined;
  const provider = data?.provider;
  const modelId = data?.modelId;
  if (typeof provider !== "string" || typeof modelId !== "string") {
    ctx.ui.notify("上一个会话没有有效的模型交接记录。", "warning");
    return;
  }

  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    ctx.ui.notify(`上一个会话使用的模型 ${provider}/${modelId} 当前不可用。`, "warning");
    return;
  }
  if (ctx.model?.provider === provider && ctx.model.id === modelId) return;

  if (!(await pi.setModel(model))) {
    ctx.ui.notify(`无法恢复模型 ${provider}/${modelId}：未配置认证。`, "warning");
  }
}

function restoreSessionAccount(
  ctx: ExtensionContext,
  state: CodexAccountState,
): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom") continue;
    const data = asRecord(entry.data);
    if (data?.sessionId !== sessionId) continue;

    if (entry.customType === SELECTION_ENTRY_TYPE) {
      const accountName = data.accountName;
      if (typeof accountName !== "string") {
        throw new Error("当前会话保存的 Codex 账户选择无效。");
      }
      requireExistingAccount(state, accountName);
      return accountName;
    }

    if (entry.customType === LEGACY_SELECTION_ENTRY_TYPE) {
      const providers = asRecord(data.providers);
      const accountName = providers?.[PROVIDER_ID];
      if (typeof accountName === "string") {
        requireExistingAccount(state, accountName);
        return accountName;
      }
    }
  }
  return state.activeAccount;
}

function persistSessionSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  accountName: string,
): void {
  const data: SelectionEntryData = {
    version: 1,
    sessionId: ctx.sessionManager.getSessionId(),
    accountName,
  };
  pi.appendEntry(SELECTION_ENTRY_TYPE, data);
}

function requireExistingAccount(
  state: CodexAccountState,
  accountName: string,
): void {
  if (!state.accounts.some((account) => account.name === accountName)) {
    throw new Error(`当前会话绑定的 Codex 账户 ${accountName} 不存在。`);
  }
}

function visibleAccounts(
  accounts: readonly CodexAccount[],
  settings: UsageSettings,
): CodexAccount[] {
  const hidden = new Set(settings.hiddenAccounts);
  return accounts.filter((account) => !hidden.has(account.name));
}

function sortUsages(
  usages: readonly AccountUsage[],
  activeAccount: string | undefined,
): AccountUsage[] {
  return [...usages].sort((left, right) => {
    const leftIsActive = left.accountName === activeAccount;
    const rightIsActive = right.accountName === activeAccount;
    if (leftIsActive !== rightIsActive) return leftIsActive ? -1 : 1;
    return left.accountName.localeCompare(right.accountName);
  });
}

function safeReadAccountState(
  ctx: ExtensionContext,
): CodexAccountState | undefined {
  try {
    return readCodexAccountState();
  } catch (error) {
    ctx.ui.setStatus(STATUS_KEY, "Codex 账户读取失败");
    ctx.ui.notify(errorMessage(error), "error");
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const indexedResults: Array<{ index: number; result: R }> = [];
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      indexedResults.push({ index, result: await mapper(value) });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return indexedResults
    .sort((left, right) => left.index - right.index)
    .map(({ result }) => result);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
