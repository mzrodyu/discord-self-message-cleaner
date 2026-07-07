# Discord Self Message Cleaner

作者：mzrodyu / catie

一个本地浏览器扩展，用于按服务器和频道批量删除当前账号自己的 Discord 消息。

## 当前版本

- 在扩展面板输入 `Discord Token`、`服务器 ID`、`频道 ID`
- token 只在当前弹窗运行时使用，不写入 `chrome.storage`
- 服务器 ID 和频道 ID 会先校验，避免删错频道
- 自动读取 `/users/@me`，只筛选作者 ID 等于自己的消息
- 支持按起始时间、结束时间过滤
- 先预览，确认后才删除
- 删除时按间隔逐条处理，降低页面和接口压力

## 安装

适合 Chrome、Edge、Brave、Arc 等 Chromium 系浏览器。

1. 打开浏览器扩展管理页。
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
2. 打开“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目文件夹，也就是能看到 `manifest.json` 的目录。
5. 点击浏览器右上角扩展图标，打开 `Discord Self Message Cleaner`。

修改项目文件后，需要在扩展管理页点击“重新加载”。

## 使用

1. 在面板里输入 token。
2. 输入要清理的 `服务器 ID` 和 `频道 ID`。
3. 设置最多删除数量、删除间隔和可选时间范围。
4. 勾选免责声明。
5. 点击“预览”，确认数量和内容片段。
6. 点击“删除预览项”，再确认一次。

## 注意

- token 不会保存，但仍建议只在自己的可信电脑上运行。
- 删除不可恢复，先用较小数量测试，例如 `10` 或 `20`。
- 普通用户只能删除自己的消息；频道权限不足或消息不存在会返回 Discord API 错误。
- 如果 Discord API 行为变化，可能需要更新 `popup.js`。

## 文件结构

```text
.
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── content.js
├── userscript/
│   └── discord-self-message-cleaner.user.js
├── LICENSE
└── .gitignore
```

`content.js` 和 `userscript/` 是旧的网页 UI 自动点击实现，当前浏览器扩展主流程不再依赖它们。

## 许可证

MIT
