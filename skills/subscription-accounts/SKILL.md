---
name: subscription-accounts
description: "Manage stacked AI subscription logins (Antigravity, Cursor, Grok, plus Claude/Codex through the Account Pooler) that bb switches between when one runs out of quota. Use when adding, switching or checking these accounts, or when a thread fails with a quota or usage-limit error."
---

# Subscription accounts

The **Subscription Accounts** page in the sidebar manages every provider. For
scripts, use `bb subs`:

```sh
bb subs list [<provider>] [--json]
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
- Claude and Codex are handled by bb's Account Pooler (`bb pool ...`). The
  page adds, orders and turns on or off those accounts through it.

To add another account, prefer the page's **Add account** button. It signs in
under a temporary HOME, so the current login stays in place. Do not log out
of a CLI to add an account, because logging out can revoke the saved copy's
refresh token.

Never print login files or the plugin database; they hold refresh tokens.
