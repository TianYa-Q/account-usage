# account-usage

A [Pi Coding Agent](https://github.com/badlogic/pi-mono) extension for:

- managing multiple OpenAI Codex OAuth accounts;
- switching the Codex account used by each session;
- displaying Codex 5-hour and weekly quota windows;
- displaying Gemini quota from the `antigravity` provider;
- exposing structured quota data to RPC clients such as [Pi Mac](https://github.com/TianYa-Q/PiMac).

## Install

```bash
pi install git:github.com/TianYa-Q/account-usage@v1.0.3
```

Restart Pi after installation. To install the latest unpinned revision instead:

```bash
pi install git:github.com/TianYa-Q/account-usage
```

## Commands

| Command | Description |
| --- | --- |
| `/accounts` | Open the Codex account manager |
| `/accounts switch <name>` | Switch the current session to an account |
| `/usage` | Show account usage |
| `/usage refresh` | Refresh quota data |
| `/usage settings` | Choose visible Codex accounts |
| `/usage history` | Show automatic warm-up history |
| `/usage show` | Show the current quota summary |

## Behavior and local data

Account credentials and settings remain on the local machine under Pi's agent directory. Credential files are written with owner-only permissions. They are never included in this package.

Quota results are shared by all running Pi sessions through an owner-only local cache. While any agent is running, its session refreshes all Codex accounts and Gemini at most once per minute. Idle sessions refresh at most once every three minutes. Other sessions reuse the shared result instead of repeating provider requests. `/usage refresh` bypasses the cache for an explicit refresh.

Quota query failures are recorded in `~/.pi/agent/account-usage-errors.jsonl` (with one rotated `.1` backup). Each JSON line includes the time, provider, account name when applicable, request stage, duration, and safe Node error/cause codes (for example `ETIMEDOUT` or `ECONNRESET`). The log is owner-only and excludes credentials, headers, URLs, and response bodies. Restart Pi/Pi Mac after updating the extension so running sessions load this diagnostics code.

When a visible Codex account has a full, unused 5-hour or 7-day window (its reset countdown is within 5 minutes of the full window), the extension may send `你好` with `gpt-5.6-luna` at low thinking level to start the countdown. Both windows are tracked independently; when they refresh together, only one request is sent. Automatic warm-ups have a 10-minute per-window cooldown, so a recent 5-hour warm-up does not block a weekly warm-up. Each window is claimed only once, and warm-ups are recorded locally.

Gemini quota display is available when the `antigravity` provider is configured. The package includes the compatible `pi-antigravity` runtime used to query its quota endpoint.

## RPC integration

In RPC mode, structured status is published under:

```text
account-usage-gui
```

The human-readable status uses:

```text
account-usage
```

## Security

Pi extensions run with the user's full system permissions. Review the source before installation. This extension stores OAuth credentials locally and uses them only for Codex authentication, quota queries, account switching, and the documented warm-up request.

## License

MIT
