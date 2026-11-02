# Contributing

Thanks for taking a look. This is a small, dependency-free project — the bar for changes is "does it work in a real Chrome, and does it stay honest about the limits".

## Ground rules

1. **No runtime dependencies** in the plugin (`index.js`, `lib/`). Node built-ins only.
2. **Keep the two halves in sync.** A new command needs a handler in `extension/background.js` *and* a tool in `index.js`. The tool description is the model's only contract — write it the way you would explain the command to a colleague.
3. **Respect the sandbox of the page.** Prefer `chrome_query` / `chrome_read_text` over `chrome_eval`; prefer a targeted selector over scraping.
4. **Never silently swallow a failure.** If a page blocks something (CSP, permissions), turn it into an actionable message.

## Development loop

```bash
npm run verify            # check + tests; run this before every commit

# try a change in the real browser:
#   1. edit extension/* — then click ↻ on chrome://extensions
#   2. edit index.js — the DSH plugin hot-reloads via plugin_manager/set_plugin
```

Chrome caches the service worker script of an unpacked extension. Editing `extension/**` always requires a manual reload; that is not a bug you can fix in code.

## Tests

`node --test` with plain `node:assert`. Host-side logic lives in `lib/` precisely so it is testable without a browser:

- `lib/policy.js` — URL allowlist
- `lib/protocol.js` — wait knobs, network dedupe/grouping, text clipping
- `test/manifest.test.js` — manifest/package consistency, referenced files exist

Browser behaviour is verified manually. When you add a command, note in the PR which page you tested it on and what you observed.

## Commit style

Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`. One behaviour per commit.

## Pull requests

Include:

- what changed and why,
- how you verified it (page, steps, observed result),
- any new limitation the user should know about.
