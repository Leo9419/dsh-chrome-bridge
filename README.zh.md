# DSH Chrome Bridge

用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 操控**你自己的 Chrome**。和 Claude 的 Chrome 集成同一套架构:动作由浏览器扩展在你眼前的窗口里执行。

```text
Agent 工具 chrome_*
      │
      ▼
DSH 插件:本机 HTTP 桥(127.0.0.1,token 鉴权)
      ▲                    │ 长轮询
      │                    ▼
      └──────── Chrome 扩展(MV3 service worker)
                     │ chrome.tabs / chrome.scripting / captureVisibleTab
                     │ (+ chrome.debugger,真实输入事件)
                     ▼
              你的 Chrome 窗口 —— 你能看见每一步
```

没有任何无头浏览器。每一次点击、输入、跳转都发生在你正在看的那个窗口里,你既看得见,也随时能打断。

## 为什么用扩展,而不是 `--remote-debugging-port`

| | 调试端口(CDP) | 扩展(本项目) |
|---|---|---|
| 启动方式 | 必须带参数重启 Chrome | 正常启动 |
| 额外提示条 | "Chrome 正在被控制" | 默认没有(除非你开 CDP 模式) |
| 用户资料 | 通常得用独立 profile | 你真实的 profile、登录态、扩展 |
| 配置成本 | 一个启动参数 | 一次性加载扩展 |

## 环境要求

- Chrome 116+(实测 156)
- Node.js 20+(仅用于跑测试/打包)
- 一个可以安装本地 bundle 的 DSH profile

## 安装

### 1. 把插件装进 DSH

```bash
dsh plugin install /path/to/dsh-chrome-bridge    # 或用 plugin_manager 工具
```

bundle 会插入一行 `chrome-bridge`,并在 `47311` 起本地桥。端口与访问 token 写在:

```
~/.dsh/storages/chrome-bridge/config.json
```

### 2. 在 Chrome 里加载扩展

1. 打开 `chrome://extensions`
2. 打开右上角**开发者模式**
3. **加载已解压的扩展程序** → 选择本仓库的 `extension/` 目录

### 3. 配对

1. 打开扩展选项(卡片 → 详情 → 扩展程序选项)
2. 填端口 `47311` 和 `config.json` 里的 token
3. **保存** → **测试连接**

扩展图标显示绿色 `ON` 即连通;`SET` 表示没填 token,`OFF` 表示连不上桥。

## 工具

| 工具 | 作用 |
|---|---|
| `chrome_status` | 连接状态、端口、标签页数 |
| `chrome_list_tabs` | 列出标签页 |
| `chrome_query` | 列出可交互元素,带可直接用的选择器与文本 |
| `chrome_open` | 新开标签页 |
| `chrome_activate` | 把标签页切到前台 |
| `chrome_navigate` | 标签页跳转 |
| `chrome_read_text` | 读页面可见文本 |
| `chrome_click` | 按 CSS 选择器**或可见文本**点击,可选等选择器/等 URL |
| `chrome_type` | 填表单,可选提交,可选等待 |
| `chrome_press` | 发送按键(Enter / Escape / Tab / 方向键) |
| `chrome_wait` | 等加载、等选择器、等 URL 片段 |
| `chrome_net` | 查页面调用了哪些后端接口 |
| `chrome_screenshot` | 截可见区域为 PNG |
| `chrome_eval` | 在页面里执行 JS(严格 CSP 站点会失败) |
| `chrome_close` | 关闭标签页 |
| `chrome_cdp` | 查看/切换 CDP 模式 |

## CDP 模式(按需开启)

默认走 `chrome.scripting`,即合成事件:快、无提示条,但有硬限制 —— `Enter` 不会触发表单默认提交,拖拽和 Canvas 点不动,`chrome_net` 也看不到 HTTP method 与请求体。

在扩展选项里打开 **CDP 模式**,会挂载 `chrome.debugger` 发送真实输入:

- 点击 → `Input.dispatchMouseEvent`(真实坐标、受信任)
- `Enter` → `Input.dispatchKeyEvent`(触发默认行为,能提交表单)
- 输入 → `Input.insertText`
- `chrome_net` → 多出 method、status、请求体摘要

挂载期间 Chrome 顶部会显示"正在被调试"提示条;关闭开关立即解除挂载,提示条消失。

## 配置

`cordis.patch.yml`:

| 键 | 默认 | 含义 |
|---|---|---|
| `port` | `47311` | 桥端口,被占用时自动退到临时端口 |
| `allowedHosts` | `[]` | 非空时只允许这些域名(含子域名)被打开/跳转 |
| `captureDir` | `""` | 截图目录,空 = `~/.dsh/storages/chrome-bridge/captures` |
| `autoStart` | `true` | 随插件启动桥 |

## 安全

- 桥只监听 `127.0.0.1`,且每个请求都要带 token。
- token 首次运行生成,存于 `~/.dsh/storages/chrome-bridge/config.json`。
- **`allowedHosts` 默认为空,意味着 Agent 可以操作任何 http(s) 站点,包括你已登录的后台和网银。** 真实使用请务必配置。
- 扩展声明了 `<all_urls>`(必须,否则无法脚本化任意页面)与 `debugger`(只在 CDP 模式开启时使用)。

完整威胁模型与漏洞上报见 [SECURITY.md](SECURITY.md)。

## 已知限制

- **合成模式**下点击/输入是 `element.click()` 与 `input` 事件,部分站点会拒绝非受信任事件;这类站点请开 CDP 模式。
- **`chrome_eval`** 在严格 CSP 站点不可用,优先用 `chrome_query` / `chrome_read_text`。
- **截图**只截可见区域,且会先把目标标签切到前台。
- **Service worker 会被回收**:扩展每 30 秒用 alarm 唤醒重连;断线期间工具会报"扩展未连接"。
- **改扩展代码必须手动点 ↻**:这是已解压扩展的固有行为。

## 开发

```bash
npm run check            # 所有入口的语法检查
npm test                 # 单元测试(node:test,零依赖)
npm run pack:extension   # 产出 dist/dsh-chrome-bridge-extension-<version>.zip
npm run verify           # check + test
```

CI 在 Node 20 / 22 上跑同样的命令。

## 许可证

MIT,见 [LICENSE](LICENSE)。
