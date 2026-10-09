---
name: subscription-accounts
description: "Manage saved AI subscription logins for Antigravity, Cursor, Grok, Claude, and Codex. Use when adding, switching or checking these accounts, or when a thread fails with a quota or usage-limit error."
---

# Subscription accounts

The **Subscription Accounts** page in the sidebar manages every provider. For
scripts, use `bb subs`:

```sh
bb subs list [<provider>] [--json]
bb subs quota [<provider>] [--refresh] [--json]
bb subs add <antigravity|cursor|grok> [<name>] [--from <login-file>] [--force]
bb subs use <provider> <name>
bb subs next <provider>
bb subs reset <provider> [<name>]
bb subs remove <provider> <name>
```

- Antigravity, Cursor and Grok: the plugin swaps the CLI's login file. On a
  quota failure it marks the account used up until its reset time, switches
  to the next account, stops the thread (so a fresh CLI reads the new login)
  and retries the turn. If every account is out, the retry is queued for the
  earliest reset.
- Claude and Codex use saved CLI login copies. The plugin switches those files directly. The Account Pooler stays off.

The page also shows each account's subscription usage, remaining allowance,
reset times and credits when reported by the provider. Usage refreshes every
five minutes; each account has a manual Refresh action. Local Claude/Codex
logins show usage before import. Missing metrics are unavailable, not zero.
A switching cooldown is separate from measured quota. Failed requests keep
dated last-known readings. Use `bb subs quota --json` to inspect current plan,
group, and model limits. Use `--refresh` for a new reading. See
`../subscription-quota/SKILL.md` for unknown data and shared-limit interpretation.
The page's **Log in again** action renews that saved account through an
isolated provider CLI sign-in, keeps its name, order and active selection, and
refreshes usage. Sign in with the same account. A different identity is
rejected. See the README for Claude/Codex link-and-code details.

Usage trends show daily tokens, Today/Yesterday/30-day totals and model shares.
Claude, Codex and Grok trends use local CLI logs and include all logins on the
machine; never attribute those totals to one stacked account. Cursor trends
use that account's server usage export. Dollars appear only when recorded;
unknown costs are not zero. Partial scans are labeled. Known quota windows
show a steady-pace estimate, not a promise about when quota will run out.

To add another account, prefer the page's **Add account** button. It signs in
under a temporary HOME, so the current login stays in place. Page-added
Claude and Codex accounts stay Ready until **Use now**. Do not log out of a
CLI to add an account, because logging out can revoke the saved copy's
refresh token.

Never print login files or the plugin database; they hold refresh tokens.
