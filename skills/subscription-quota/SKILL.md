---
name: subscription-quota
description: "Check remaining AI subscription quota before choosing a provider, account, or model, or when a task hits a usage limit."
---

# Check subscription quota

1. Run `bb subs quota` for every saved account, or `bb subs quota <provider>` for one provider. It prints a compact table built for agents and returns within 8 seconds.
2. Read the `quota` table. Each row is one account and scope:
   - `scope` `all` is the account's own limit. A `group:` or `feature:` row also counts the account limit, and appears only when the group itself is lower.
   - `left` is the share left, or `unknown (last N%)` when the reading failed or is old.
   - `runway` is `out`, `runs out <time>` (before the reset at the current pace), `lasts to reset`, or `unknown`. It assumes steady use within each window.
   - `limitedBy` names the window that binds the row.
3. Act on the `attention` table: each row has an issue and the `next` step. `none` means nothing to run.
4. Use the `pick` table for the account per provider with the most left. A near tie keeps the account in use; then the sooner reset wins, because quota left at a reset is lost.
5. Add `--refresh` for new readings, `--full` for every window and model, or `--json` for data (the same summary is under `summary`).

Switching with `bb subs use <provider> <name>` moves every thread on this server to that account. Do it only when the owner asked, or when the account in use is out.

`remaining: null` in JSON means unknown. `lastKnownRemaining` is historical evidence, not current allowance. A missing reset time is unknown. Shared account or group limits are never assigned to individual models.

If login expired, report quota as unknown. The owner can use **Log in again** beside the saved account (isolated CLI sign-in for every provider, including Claude and Codex).
