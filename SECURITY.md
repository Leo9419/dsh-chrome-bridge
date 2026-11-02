# Security policy

## What this project can do

The bridge lets an AI agent operate a real Chrome profile. That is the product, and it is also the risk: an agent that can click and type can do anything *you* can do in that browser — read mail, move money, change account settings.

Design boundaries that keep this bounded:

1. **Localhost only.** The bridge listens on `127.0.0.1`, never `0.0.0.0`.
2. **Token required.** Every request carries a token generated on first run and stored outside the repo (`~/.dsh/storages/chrome-bridge/config.json`). Without it the bridge returns 403.
3. **The user's browser.** Nothing is headless; the user watches the same window and can take over at any moment.
4. **Opt-in trusted input.** `chrome.debugger` is only attached when the user enables CDP mode, and detaches when disabled.
5. **Host allowlist.** `allowedHosts` restricts which origins may be opened or navigated. **It is empty by default** — set it before pointing the bridge at anything sensitive.

## Threat model

| Threat | Mitigation |
|---|---|
| Another local process talks to the bridge | token in every request; port bound to loopback |
| A malicious web page tries to reach the bridge | CORS preflight is answered, but without the token every call fails |
| The agent browses to an unexpected site | `allowedHosts` |
| The agent performs an irreversible action | visible window + your own judgement; run it against a non-critical profile |
| A compromised dependency | zero runtime dependencies in the plugin; the extension vendor is you |

The bridge does **not** attempt to sandbox the agent's intent. If you need that, keep `allowedHosts` tight and use a dedicated Chrome profile.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security → Advisories → Report a vulnerability) rather than a public issue. Include:

- what an attacker gains,
- the exact reproduction steps,
- the version/commit you tested.

Expect an acknowledgement within a few days. Please do not open a public issue until a fix or mitigation is agreed.
