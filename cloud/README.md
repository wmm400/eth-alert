# ETH 4H 云端提醒（GitHub Actions + Bark）

手机锁屏也能收到推送，不需要打开任何 App，也不需要自己的服务器。

## 原理

```
GitHub Actions 定时（每 4 小时）
  → 运行 cloud/alert.js
  → 拉 Gate / Binance / OKX 的 4H K 线
  → 跑强位模型（得分≥10、2R、两档加仓）
  → 高分信号（score>14）仓位×3，最多同时 2 笔、总仓位 ≤8 ETH
  → 有信号/有平仓就调用 Bark 推送
  → iPhone 锁屏收到通知
```

## 仓位规则（v3）

| 情况 | 处理 |
|---|---|
| 空仓出现信号（score 10–14） | 开 1 ETH |
| 空仓出现高分信号（score > 14） | 开 **3 ETH** |
| 已有 1 笔，再来高分信号（同向） | 允许**并行**再开 3 ETH（最多同时 2 笔） |
| 已有 1 笔，再来普通信号 | 不开，只推送“未开仓” |
| 已有 2 笔 | 任何信号都不再开 |
| 总仓位 | 不超过 8 ETH |
| 加仓 | 回撤 0.25R / 0.35R 各加 0.5 ETH；高分单加仓同步 ×3 |
| 平仓 | 止损 / 2R 止盈 / 满 10 天收盘平仓 |

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

## 六、状态与纸面持仓

`cloud/state.json` 现在记录的是**纸面持仓**（脚本认为自己开过的仓），不是你的真实账户：

```json
{
  "lastSignalTs": 0,
  "positions": [
    {
      "id": "1793145600000-short-14.59",
      "side": "short",
      "entries": [{"px": 2354, "size": 3}, {"px": 2365, "size": 1.5}],
      "stop": 2400,
      "risk": 46,
      "target": 2262,
      "score": 14.59,
      "big": true,
      "openedAt": 1793145600000,
      "addsDone": 1
    }
  ],
  "realizedUsd": 0,
  "closedCount": 0,
  "winCount": 0,
  "notified10": []
}
```

- 每次运行会：先检查持仓是否触发止损/止盈/满 10 天 → 平仓并累计；再判断新信号；
- 持仓满 10 天时，脚本按该根 K 线收盘价自动平仓，并推送平仓结果；
- 同一根 K 线不会重复开仓（用 K 线时间戳去重）。

**重要**：如果你实际没有按提醒开仓/平仓，纸面持仓会与真实情况不一致。想清零重来，把 `positions` 改成 `[]`、`realizedUsd/closedCount/winCount` 归零即可；或者直接在 GitHub 网页上编辑 `cloud/state.json`。

> 旧版 state（只有 `openTime`）会自动迁移：缺少的字段按空值补齐，不会报错。

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
- 打开 `cloud/alert.js` 顶部的 `CONFIG`：
  - `minScore`：强位门槛（默认 10）
  - `highScore` / `highMult`：高分阈值与倍数（默认 14 / ×3）
  - `maxPositions` / `maxEth`：最多同时几笔、总仓位上限（默认 2 / 8 ETH）
  - `addLevels` / `addSize`：加仓位置与每次加仓量（默认 0.25R、0.35R / 0.5 ETH）
  - `rr` / `timeStopDays`：止盈倍数、时间止损天数

**5. 想同时推企业微信/飞书**
- 在 `push()` 里加一个 webhook POST 即可，格式是 `{ msgtype: "text", text: { content } }`。

## 八、免责声明

这只是信号提醒工具，不构成投资建议，也不会自动下单。加密资产波动大，请自行控制仓位与杠杆。


## 九、推送频率与内容

**每次运行都会推送一条**，标题按情况变化：

| 标题 | 含义 |
|---|---|
| `ETH 4H 做多/做空信号` | 空仓开仓（高分时带「·高分×3」） |
| `ETH 4H 做空信号·高分并行` | 已有 1 笔时，高分信号再开一笔 |
| `ETH 4H 做空信号·未开仓` | 有信号但已有仓位/已满 2 笔，未开 |
| `ETH 4H · 平仓提醒` | 本根 K 线触发了止损/止盈/满 10 天 |
| `ETH 4H · 无信号` | 条件未满足 |

正文固定包含：

- 价格、RSI、ATR；
- 当前持仓（方向、均价、止损、止盈）；
- 累计已平笔数、胜率、已实现盈亏（纸面）；
- 满 10 天自动平仓的记录（按收盘价）。

定时任务每天 6 次（北京时间 08:05 / 12:05 / 16:05 / 20:05 / 00:05 / 04:05），也就是每天 6 条推送。

如果觉得太频繁，把无信号分支里的 `await push(...)` 改成只平仓/开仓时推送即可。
