---
name: subscription-quota
description: "Check remaining AI subscription quota before choosing a provider, account, or model, or when a task hits a usage limit."
---

# Check subscription quota

1. Run `bb subs quota --json` for all saved subscription accounts. Add a provider name to inspect one provider.
2. Read each account's plan, status, retrieval time, and limits. Use `bb subs quota` for a readable report.
3. If data is stale or a new reading is needed, run `bb subs quota --refresh --json`. The command normally refreshes readings older than five minutes.
4. If login expired, report quota as unknown. The owner can use **Log in again** beside the saved Antigravity, Cursor, or Grok account. Claude and Codex require their CLI login, then **Save it**.

`limits` keeps provider units such as percent, USD, requests, and credits. Percent values come from provider percentages or reported fractions multiplied by 100. They do not imply a token or request budget.

A limit without `scope` belongs to the account or plan. A `group` shares quota among a model group. A `feature` names a metered feature. Only `model` supplies a model-specific quota. Do not assign shared limits to individual models or add shared and model limits together.

`remaining: null` means unknown, including failed or stale readings. `lastKnownRemaining` is historical evidence, not current allowance. `retrievedAt` is the last successful reading. `checkedAt` is the latest quota request. A missing reset time is unknown.

The command does not select an account or start a login. Provider token refresh can update credentials through the existing usage service. Switching cooldowns and local token history are separate from reported quota.
