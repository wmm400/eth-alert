# ETH 4H 云端提醒（GitHub Actions + Bark）

手机锁屏也能收到推送，不需要打开任何 App，也不需要自己的服务器。

## 原理

```
GitHub Actions 定时（每 4 小时）
  → 运行 cloud/alert.js
  → 拉 Gate / Binance / OKX 的 4H K 线
  → 跑强位模型（得分≥10、2R、两档加仓）
  → 有信号就调用 Bark 推送
  → iPhone 锁屏收到通知
```

## 目录

```
cloud/
  alert.js      主脚本（模型 + 推送）
  state.json    状态（上次信号、开仓时间），由 Action 自动提交
.github/
  workflows/
    eth-alert.yml   定时任务
```

## 一、准备 Bark

1. App Store 搜索 **Bark**（免费）安装。
2. 打开 App，首页有一串 **推送地址**，形如：
   `https://api.day.app/AbCdEfG123456/`
3. 复制中间那段 key：`AbCdEfG123456`。

## 二、创建 GitHub 仓库

1. 注册/登录 GitHub。
2. 新建仓库，名称随意（如 `eth-alert`），**Private 或 Public 都可以**。
3. 把本目录的 `cloud/` 和 `.github/` 两个文件夹上传到仓库根目录。

> 网页上传：仓库首页 → Add file → Upload files → 拖入两个文件夹 → Commit。

## 三、配置密钥

1. 仓库 → **Settings** → **Secrets and variables** → **Actions**。
2. **New repository secret**：
   - Name：`BARK_KEY`
   - Secret：粘贴你的 Bark key（多个用英文逗号分隔，会同时推给多台设备）。
3. 保存。

## 四、启用 Actions

1. 仓库 → **Actions** 标签页 → 如果提示，点 **I understand my workflows, go ahead and enable them**。
2. 左侧选 **ETH 4H Alert** → 右侧 **Run workflow** → 运行一次测试。
3. 点进这次运行，看日志：
   - `last closed bar ...` 说明取数成功；
   - `signal ...` / `no signal` 说明模型跑通；
   - `bark 200` 说明推送成功。
4. 手机上应该收到一条测试推送（如果当前没有信号，日志会显示 nothing to push，不会发推送）。

## 五、定时说明

`.github/workflows/eth-alert.yml` 里的 cron：

```
5 0,4,8,12,16,20 * * *   （UTC）
```

对应北京时间 **08:05 / 12:05 / 16:05 / 20:05 / 00:05 / 04:05**，即每根 4H K 线收盘后 5 分钟。

GitHub 的定时任务**可能延迟 5–15 分钟**，对 4 小时周期没有影响。

## 六、状态与 10 天提醒

- 每次推送信号后，脚本会把「开仓时间」写进 `cloud/state.json`，并由 Action 自动提交回仓库。
- 之后满 10 天，会再推一条「持仓已满 10 天」提醒（每笔只提醒一次）。
- 同一根 K 线不会重复推送（用 K 线时间戳去重）。

注意：脚本无法知道你实际是否开仓/平仓，10 天提醒是「按信号时间」估算的，仅供参考。

## 七、常见问题

**1. 没收到推送**
- 检查 Bark App 是否允许通知；
- 看 Action 日志里 `BARK_KEY 未设置` 或 `bark 4xx`；
- key 复制时不要带 `https://api.day.app/` 前缀和末尾斜杠。

**2. Action 运行失败：`git push` 被拒绝**
- 仓库 Settings → Actions → General → Workflow permissions 选 **Read and write permissions**；
- 如果分支有保护规则，允许 bot 提交或关闭保护。

**3. 私有仓库会消耗额度吗**
- 会，但每月免费 2,000 分钟；这套每月约 6 次 × 20 秒 ≈ 2 分钟，完全够用。
- 公开仓库不计费。

**4. 想改参数**
- 打开 `cloud/alert.js` 顶部的 `CONFIG`：强位门槛、止盈倍数、加仓位置、时间止损天数都在那里。

**5. 想同时推企业微信/飞书**
- 在 `push()` 里加一个 webhook POST 即可，格式是 `{ msgtype: "text", text: { content } }`。

## 八、免责声明

这只是信号提醒工具，不构成投资建议，也不会自动下单。加密资产波动大，请自行控制仓位与杠杆。
