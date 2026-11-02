# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-02

Initial public release.

### Added

- DSH host plugin that exposes a localhost, token-authenticated bridge on `127.0.0.1:47311`.
- MV3 Chrome extension that polls the bridge and executes commands in the user's own visible browser window.
- Tools: `chrome_status`, `chrome_list_tabs`, `chrome_query`, `chrome_open`, `chrome_activate`, `chrome_navigate`, `chrome_read_text`, `chrome_click`, `chrome_type`, `chrome_press`, `chrome_wait`, `chrome_net`, `chrome_screenshot`, `chrome_eval`, `chrome_close`, `chrome_cdp`.
- Click by visible text as an alternative to brittle CSS paths.
- Wait-for-ready support on click/type/press (`waitForSelector`, `waitForUrl`, `timeoutMs`) plus a standalone `chrome_wait`, including following a tab opened by `target=_blank`.
- iframe awareness: text reading, queries and actions run across all frames.
- Optional CDP mode: trusted mouse/keyboard events via `chrome.debugger`, and network capture with HTTP methods and request-body previews.
- Host allowlist (`allowedHosts`), screenshot capture directory, automatic port fallback.
- Unit tests for URL policy, protocol helpers and manifest/package consistency; GitHub Actions CI on Node 20 and 22.

### Known limitations

- Synthetic (non-CDP) clicks cannot trigger default actions such as `Enter` submitting a form.
- `chrome_eval` fails on strict-CSP sites.
- Screenshots cover the visible viewport only.
- An unpacked extension must be reloaded manually after code changes.
