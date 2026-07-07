# Discord Self Message Cleaner

作者：mzrodyu / catie

仓库：<https://github.com/mzrodyu/discord-self-message-cleaner>

一个开源的浏览器扩展，用于在 Discord 网页端批量删除当前频道里当前登录账号自己的可见消息。

## 特性

- Manifest V3 浏览器扩展
- iOS 风格纯色界面，不使用渐变色
- 在 `https://discord.com/*` 页面运行
- 弹窗里设置每轮删除数量、删除间隔、是否自动向上加载更早消息
- 通过 Discord 网页 UI 自动点击“更多 -> 删除 -> 确认”，不使用私有 API
- 可随时停止当前删除任务

## 安装

如果只是自己用，推荐先装“浏览器扩展版”。不需要打包，不需要命令行，直接加载这个文件夹就能用。

### 浏览器扩展版

适合 Chrome、Edge、Brave、Arc 等 Chromium 系浏览器。

1. 下载本项目代码。
   - 如果你在 GitHub 页面：点击绿色 `Code` 按钮，再点 `Download ZIP`
   - 下载后把 ZIP 解压到一个固定位置，例如桌面或文档目录
2. 打开浏览器扩展管理页。
   - Chrome 地址栏输入：`chrome://extensions/`
   - Edge 地址栏输入：`edge://extensions/`
3. 打开页面右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压后的项目文件夹，也就是里面能看到 `manifest.json` 的那个文件夹。
6. 打开 Discord 网页版：`https://discord.com/channels/...`
7. 进入要清理的频道。
8. 点击浏览器右上角的扩展图标，找到 `Discord Self Message Cleaner`。
9. 设置“每轮最多删除”和“删除间隔”，点击“开始删除”。

如果修改了本项目文件，需要回到扩展管理页点一次“重新加载”，再刷新 Discord 页面。

### 油猴脚本版

适合已经在用 Tampermonkey 或 Violentmonkey 的用户。

1. 先安装一个用户脚本管理器。
   - Tampermonkey：<https://www.tampermonkey.net/>
   - Violentmonkey：<https://violentmonkey.github.io/>
2. 打开脚本管理器，点击“新建脚本”。
3. 删除默认模板内容。
4. 打开本项目的 `userscript/discord-self-message-cleaner.user.js`。
5. 复制整个文件内容，粘贴到新建脚本里。
6. 保存脚本。
7. 打开 Discord 网页版：`https://discord.com/channels/...`
8. 进入要清理的频道。
9. 页面右下角会出现控制面板，设置参数后点击“开始”。

如果页面没有出现控制面板，先确认脚本管理器已启用，再刷新 Discord 页面。

## 使用建议

- 删除间隔建议保持在 `1200ms` 以上，避免页面状态来不及更新。
- 先用较小数量测试，例如 `10` 或 `20`。
- 清理时保持 Discord 当前频道页面打开，不要频繁切频道。
- 该扩展只能删除当前账号有权限删除的消息。普通用户通常只能删除自己的消息。
- Discord 前端 DOM 结构可能变化；如果按钮定位失效，需要更新 `content.js` 里的选择器。

## 运行逻辑

扩展的内容脚本会扫描当前频道已加载的消息节点，逐条尝试打开消息菜单并点击删除确认。启用自动加载时，如果当前视图没有可删除消息，会向上滚动以加载更早消息。

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

## 开发

修改文件后，在浏览器扩展管理页点击“重新加载”，再刷新 Discord 页面。

## 许可证

MIT
