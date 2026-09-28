import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type {
  AutoWarmupRecord,
  CodexAccountState,
  UsageSettings,
} from "./types.js";

const STORE_PATH = join(getAgentDir(), "codex-accounts.json");
const LEGACY_ACCOUNTS_PATH = join(getAgentDir(), "pi-accounts.json");
const SETTINGS_PATH = join(getAgentDir(), "codex-account-usage.json");
const AUTO_WARMUP_STATE_PATH = join(
  getAgentDir(),
  "codex-account-auto-warmup.json",
);
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/u;

type StoreDocument = {
  version: 1;
  active?: string;
  accounts: Record<string, OAuthCredential>;
};

type AutoWarmupState = {
  version: 1;
  claimedWindowResetAtByAccount: Record<string, number>;
  claimedAtByAccount: Record<string, number>;
  weeklyClaimedWindowResetAtByAccount: Record<string, number>;
  weeklyClaimedAtByAccount: Record<string, number>;
  records: AutoWarmupRecord[];
};

const MAX_AUTO_WARMUP_RECORDS = 100;
const AUTO_WARMUP_CLAIM_LEASE_MS = 2 * 60 * 1_000;

type AsyncLockLease = {
  release(): Promise<void>;
  throwIfCompromised(): void;
};

export function readCodexAccountState(): CodexAccountState {
  return withStoreLock((document) => ({
    accounts: Object.entries(document.accounts)
      .map(([name, credential]) => ({
        name,
        credential: structuredClone(credential),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    activeAccount: document.active,
  }));
}

export async function saveAccount(
  accountName: string,
  credential: OAuthCredential,
): Promise<void> {
  validateAccountName(accountName);
  await updateStore((document) => {
    document.accounts[accountName] = validateCredential(
      credential,
      accountName,
    );
  });
}

export async function setActiveAccount(accountName: string): Promise<void> {
  validateAccountName(accountName);
  await updateStore((document) => {
    if (!Object.hasOwn(document.accounts, accountName)) {
      throw new Error(`Codex 账户 ${accountName} 不存在。`);
    }
    document.active = accountName;
  });
}

export async function removeAccount(accountName: string): Promise<void> {
  validateAccountName(accountName);
  await updateStore((document) => {
    if (document.active === accountName) {
      throw new Error("不能删除当前默认账户，请先切换到其他账户。");
    }
    if (!Object.hasOwn(document.accounts, accountName)) {
      throw new Error(`Codex 账户 ${accountName} 不存在。`);
    }
    delete document.accounts[accountName];
  });
}

export async function refreshStoredCredential(
  accountName: string,
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>,
): Promise<OAuthCredential> {
  validateAccountName(accountName);
  const lease = await acquireStoreLock();
  try {
    const document = readStoreDocument();
    const current = document.accounts[accountName];
    if (!current) throw new Error(`Codex 账户 ${accountName} 不存在。`);
    const refreshed = validateCredential(await refresh(current), accountName);
    lease.throwIfCompromised();
    document.accounts[accountName] = refreshed;
    writePrivateJson(STORE_PATH, document);
    return structuredClone(refreshed);
  } finally {
    await lease.release();
  }
}

export function readSettings(): UsageSettings {
  try {
    return parseSettings(readPrivateRegularFile(SETTINGS_PATH));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, hiddenAccounts: [] };
    }
    throw error;
  }
}

export function writeSettings(settings: UsageSettings): void {
  const normalized: UsageSettings = {
    version: 1,
    hiddenAccounts: [...new Set(settings.hiddenAccounts)].sort(),
  };
  for (const name of normalized.hiddenAccounts) validateAccountName(name);
  writePrivateJson(SETTINGS_PATH, normalized);
}

/** 多个 Pi 进程原子领取额度窗口，并阻止成功发送后的短时间重复唤醒。 */
export async function claimAutoWarmupWindow(
  accountName: string,
  windowResetAt: number,
  now: number,
  successfulCooldownMs: number,
  bypassSuccessCooldown = false,
  windowKind: "5h" | "7d" = "5h",
): Promise<boolean> {
  validateAccountName(accountName);
  if (!Number.isFinite(windowResetAt) || windowResetAt <= 0) {
    throw new Error("自动唤醒窗口重置时间无效。");
  }
  if (
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(successfulCooldownMs) ||
    successfulCooldownMs <= 0
  ) {
    throw new Error("自动唤醒冷却时间参数无效。");
  }

  const lease = await acquirePathLock(AUTO_WARMUP_STATE_PATH);
  try {
    const state = readAutoWarmupState();
    const hasRecentSuccess = state.records.some(
      (record) =>
        record.accountName === accountName &&
        (record.windowKind ?? "5h") === windowKind &&
        record.status === "success" &&
        now - record.timestamp < successfulCooldownMs,
    );
    const resetMap =
      windowKind === "7d"
        ? state.weeklyClaimedWindowResetAtByAccount
        : state.claimedWindowResetAtByAccount;
    const claimMap =
      windowKind === "7d"
        ? state.weeklyClaimedAtByAccount
        : state.claimedAtByAccount;
    const claimedResetAt = resetMap[accountName];
    const claimedAt = claimMap[accountName];
    const hasLiveClaim =
      claimedAt !== undefined && now - claimedAt < AUTO_WARMUP_CLAIM_LEASE_MS;
    if (
      (!bypassSuccessCooldown && hasRecentSuccess) ||
      hasLiveClaim ||
      (claimedResetAt !== undefined && claimedResetAt >= windowResetAt)
    ) {
      return false;
    }
    lease.throwIfCompromised();
    writePrivateJson(AUTO_WARMUP_STATE_PATH, {
      ...state,
      ...(windowKind === "7d"
        ? {
            weeklyClaimedWindowResetAtByAccount: {
              ...resetMap,
              [accountName]: windowResetAt,
            },
            weeklyClaimedAtByAccount: { ...claimMap, [accountName]: now },
          }
        : {
            claimedWindowResetAtByAccount: {
              ...resetMap,
              [accountName]: windowResetAt,
            },
            claimedAtByAccount: { ...claimMap, [accountName]: now },
          }),
    } satisfies AutoWarmupState);
    return true;
  } finally {
    await lease.release();
  }
}

export async function appendAutoWarmupRecords(
  records: readonly AutoWarmupRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const normalized = records.map(validateAutoWarmupRecord);
  const lease = await acquirePathLock(AUTO_WARMUP_STATE_PATH);
  try {
    const state = readAutoWarmupState();
    lease.throwIfCompromised();
    writePrivateJson(AUTO_WARMUP_STATE_PATH, {
      ...state,
      records: [...state.records, ...normalized].slice(
        -MAX_AUTO_WARMUP_RECORDS,
      ),
    } satisfies AutoWarmupState);
  } finally {
    await lease.release();
  }
}

export async function readAutoWarmupRecords(): Promise<AutoWarmupRecord[]> {
  const lease = await acquirePathLock(AUTO_WARMUP_STATE_PATH);
  try {
    const records = readAutoWarmupState().records.map((record) => ({
      ...record,
    }));
    lease.throwIfCompromised();
    return records;
  } finally {
    await lease.release();
  }
}

async function updateStore(
  mutate: (document: StoreDocument) => void,
): Promise<void> {
  const lease = await acquireStoreLock();
  try {
    const document = readStoreDocument();
    mutate(document);
    lease.throwIfCompromised();
    writePrivateJson(STORE_PATH, document);
  } finally {
    await lease.release();
  }
}

function withStoreLock<T>(reader: (document: StoreDocument) => T): T {
  ensureStoreParent();
  const release = lockfile.lockSync(STORE_PATH, { realpath: false });
  try {
    return reader(readStoreDocument());
  } finally {
    release();
  }
}

async function acquireStoreLock(): Promise<AsyncLockLease> {
  return acquirePathLock(STORE_PATH);
}

async function acquirePathLock(path: string): Promise<AsyncLockLease> {
  ensureStoreParent();
  let compromised: Error | undefined;
  const releaseLock = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 8, factor: 2, minTimeout: 50, maxTimeout: 1_000 },
    // The default callback throws from a heartbeat timer and terminates Pi.
    // Record the failure so the active operation can reject through its promise.
    onCompromised: (error) => {
      compromised = compromisedLockError(path, error);
    },
  });
  return {
    throwIfCompromised() {
      if (compromised) throw compromised;
    },
    async release() {
      try {
        if (!compromised) await releaseLock();
      } catch (error) {
        if (!compromised) throw error;
      }
      if (compromised) throw compromised;
    },
  };
}

function compromisedLockError(path: string, cause: Error): Error {
  return new Error(`账户数据锁已失效（${path}），已取消本次操作。`, {
    cause,
  });
}

function readStoreDocument(): StoreDocument {
  try {
    return parseStoreDocument(readPrivateRegularFile(STORE_PATH));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  const migrated = readLegacyStore();
  writePrivateJson(STORE_PATH, migrated);
  return migrated;
}

function readLegacyStore(): StoreDocument {
  try {
    const value = parseJson(readPrivateRegularFile(LEGACY_ACCOUNTS_PATH));
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.providers)) {
      throw new Error("pi-accounts.json 数据结构无效，无法迁移。");
    }
    const provider = value.providers["openai-codex"];
    if (!isRecord(provider) || !isRecord(provider.accounts)) {
      return { version: 1, accounts: {} };
    }
    return normalizeStoreDocument({
      version: 1,
      active: provider.active,
      accounts: provider.accounts,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, accounts: {} };
    }
    throw error;
  }
}

function parseStoreDocument(raw: string): StoreDocument {
  return normalizeStoreDocument(parseJson(raw));
}

function readAutoWarmupState(): AutoWarmupState {
  try {
    const value = parseJson(readPrivateRegularFile(AUTO_WARMUP_STATE_PATH));
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      (value.claimedWindowResetAtByAccount !== undefined &&
        !isRecord(value.claimedWindowResetAtByAccount)) ||
      (value.claimedAtByAccount !== undefined &&
        !isRecord(value.claimedAtByAccount)) ||
      (value.weeklyClaimedWindowResetAtByAccount !== undefined &&
        !isRecord(value.weeklyClaimedWindowResetAtByAccount)) ||
      (value.weeklyClaimedAtByAccount !== undefined &&
        !isRecord(value.weeklyClaimedAtByAccount)) ||
      (value.records !== undefined && !Array.isArray(value.records))
    ) {
      throw new Error("codex-account-auto-warmup.json 数据结构无效。");
    }
    const claimedWindowResetAtByAccount = parseAccountTimestamps(
      value.claimedWindowResetAtByAccount,
      "自动唤醒窗口记录",
    );
    const claimedAtByAccount = parseAccountTimestamps(
      value.claimedAtByAccount,
      "自动唤醒领取记录",
    );
    return {
      version: 1,
      claimedWindowResetAtByAccount,
      claimedAtByAccount,
      weeklyClaimedWindowResetAtByAccount: parseAccountTimestamps(
        value.weeklyClaimedWindowResetAtByAccount,
        "每周自动唤醒窗口记录",
      ),
      weeklyClaimedAtByAccount: parseAccountTimestamps(
        value.weeklyClaimedAtByAccount,
        "每周自动唤醒领取记录",
      ),
      records: (value.records ?? []).map(validateAutoWarmupRecord),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        version: 1,
        claimedWindowResetAtByAccount: {},
        claimedAtByAccount: {},
        weeklyClaimedWindowResetAtByAccount: {},
        weeklyClaimedAtByAccount: {},
        records: [],
      };
    }
    throw error;
  }
}

function parseAccountTimestamps(
  value: unknown,
  label: string,
): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label}无效。`);

  const timestamps: Record<string, number> = {};
  for (const [accountName, timestamp] of Object.entries(value)) {
    validateAccountName(accountName);
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      timestamp <= 0
    ) {
      throw new Error(`${label}无效。`);
    }
    timestamps[accountName] = timestamp;
  }
  return timestamps;
}

function validateAutoWarmupRecord(value: unknown): AutoWarmupRecord {
  if (
    !isRecord(value) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp < 0 ||
    typeof value.accountName !== "string" ||
    (value.status !== "success" && value.status !== "failed") ||
    (value.windowKind !== undefined &&
      value.windowKind !== "5h" &&
      value.windowKind !== "7d") ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error("自动启动记录数据无效。");
  }
  validateAccountName(value.accountName);
  return {
    timestamp: value.timestamp,
    accountName: value.accountName,
    status: value.status,
    ...(value.windowKind === undefined ? {} : { windowKind: value.windowKind }),
    error: value.error,
  };
}

function normalizeStoreDocument(value: unknown): StoreDocument {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.accounts)) {
    throw new Error("codex-accounts.json 数据结构无效。");
  }

  const accounts: Record<string, OAuthCredential> = {};
  for (const [name, credential] of Object.entries(value.accounts)) {
    validateAccountName(name);
    accounts[name] = validateCredential(credential, name);
  }

  if (value.active !== undefined) {
    if (typeof value.active !== "string") {
      throw new Error("当前 Codex 账户名称必须是字符串。");
    }
    validateAccountName(value.active);
    if (!Object.hasOwn(accounts, value.active)) {
      throw new Error(`当前 Codex 账户 ${value.active} 不存在。`);
    }
  }

  return value.active === undefined
    ? { version: 1, accounts }
    : { version: 1, active: value.active, accounts };
}

function validateCredential(
  value: unknown,
  accountName: string,
): OAuthCredential {
  if (
    !isRecord(value) ||
    value.type !== "oauth" ||
    typeof value.access !== "string" ||
    !value.access ||
    typeof value.refresh !== "string" ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires)
  ) {
    throw new Error(`账户 ${accountName} 的 OAuth 凭据不完整。`);
  }
  return structuredClone(value) as OAuthCredential;
}

function parseSettings(raw: string): UsageSettings {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.hiddenAccounts)
  ) {
    throw new Error("codex-account-usage.json 数据结构无效。\n");
  }
  const hiddenAccounts = value.hiddenAccounts.map((name) => {
    if (typeof name !== "string") {
      throw new Error("隐藏账户名称必须是字符串。\n");
    }
    validateAccountName(name);
    return name;
  });
  return { version: 1, hiddenAccounts: [...new Set(hiddenAccounts)].sort() };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("账户配置不是合法 JSON，已停止读取。");
  }
}

function validateAccountName(name: string): void {
  if (!ACCOUNT_NAME_RE.test(name)) throw new Error(`账户名称 ${name} 无效。`);
}

function ensureStoreParent(): void {
  const parent = dirname(STORE_PATH);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
}

function readPrivateRegularFile(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${path} 必须是普通文件。`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${path} 必须是普通文件。`);
    }
    fchmodSync(descriptor, 0o600);
    return readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 保留原始写入错误；临时文件清理失败不能掩盖根因。
    }
    throw new Error(`写入 ${path} 失败：${errorMessage(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
