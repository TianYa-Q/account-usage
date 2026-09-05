import type { OAuthCredential } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "openai-codex";

export type CodexAccount = {
  name: string;
  credential: OAuthCredential;
};

export type CodexAccountState = {
  accounts: CodexAccount[];
  activeAccount: string | undefined;
};

export type UsageWindow = {
  remainingPercent: number;
  resetAt: number | undefined;
  windowSeconds: number | undefined;
};

export type AccountUsage = {
  accountName: string;
  capturedAt: number;
  primary: UsageWindow | undefined;
  secondary: UsageWindow | undefined;
  error: string | undefined;
};

export type UsageSettings = {
  version: 1;
  hiddenAccounts: string[];
};
