// ETH 4H 强位模型 · 云端提醒（GitHub Actions + Bark）
// 依赖：Node 18+（自带 fetch），无需 npm 包
//
// 规则（v3）：
//   - 强位评分 ≥10 才出信号；止损 = 强位 ∓0.15 ATR；止盈 2R；持仓满 10 天收盘平仓
//   - 首仓 1 ETH；score > 14 的高分信号仓位 ×3
//   - 高分信号允许与已有仓位并行，最多同时 2 笔，总仓位上限 8 ETH
//   - 加仓：价格回撤 0.25R / 0.35R 各加 0.5 ETH（高分单加仓同步 ×3）
const fs = require("fs");
const path = require("path");

const CONFIG = {
  minScore: 10,
  rr: 2.0,
  addLevels: [0.25, 0.35],
  addSize: 0.5,
  minRisk: 20, // 止损距离下限：小于它就把止损拉到 20（不放弃信号）
  maxRiskAtr: 3,
  timeStopDays: 10,
  // 高分加倍规则
  highScore: 14,
  highMult: 3,
  maxPositions: 2,
  maxEth: 8
};
const STATE_PATH = path.join(__dirname, "state.json");
const BAR_MS = 4 * 3600 * 1000;
const FEE = 0.0005;

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function rsi(values, period) {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) gain += d; else loss -= d; }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function atr(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let a = 0;
  for (let i = 0; i < period; i++) a += trs[i];
  a /= period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}
function bollinger(closes, i, n, k) {
  const seg = closes.slice(i - n + 1, i + 1);
  const avg = seg.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - avg) ** 2, 0) / n);
  return { lo: avg - k * sd, up: avg + k * sd };
}
function pivots(c) {
  const p = (c.h + c.l + c.c) / 3;
  return { r1: 2 * p - c.l, s1: 2 * p - c.h, r2: p + (c.h - c.l), s2: p - (c.h - c.l), r3: c.h + 2 * (p - c.l), s3: c.l - 2 * (c.h - p) };
}
function swings(candles, k) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isH = false;
      if (candles[j].l <= candles[i].l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push({ price: candles[i].h, i, vol: candles[i].v });
    if (isL) lows.push({ price: candles[i].l, i, vol: candles[i].v });
  }
  return { highs, lows };
}
function buildLevels(candles, price, a) {
  const n = candles.length;
  const sw = swings(candles, 4);
  const pv = pivots(candles[n - 2] || candles[n - 1]);
  const pts = [];
  sw.highs.forEach(x => pts.push({ price: x.price, type: "high", i: x.i, vol: x.vol }));
  sw.lows.forEach(x => pts.push({ price: x.price, type: "low", i: x.i, vol: x.vol }));
  ["r1", "r2", "r3", "s1", "s2", "s3"].forEach(k => pts.push({ price: pv[k], type: "pivot", i: n - 1, vol: 0 }));
  let avgVol = 0;
  candles.forEach(c => avgVol += c.v || 0);
  avgVol /= n || 1;
  const merge = Math.max(a * 0.35, price * 0.004);
  const sorted = pts.slice().sort((x, y) => y.price - x.price);
  const groups = [];
  for (const p of sorted) {
    let hit = null;
    for (const g of groups) if (Math.abs(g.anchor - p.price) <= merge) { hit = g; break; }
    if (hit) hit.items.push(p); else groups.push({ anchor: p.price, items: [p] });
  }
  const roundStep = price > 1000 ? 50 : 10;
  const scored = groups.map(g => {
    const touches = Math.min(g.items.length, 5);
    const rec = Math.max.apply(null, g.items.map(x => x.i)) / n;
    const v = g.items.reduce((s, x) => s + (x.vol || 0), 0) / g.items.length;
    const roundDist = Math.abs(g.anchor - Math.round(g.anchor / roundStep) * roundStep);
    return {
      price: g.anchor, touches: g.items.length,
      score: touches * 2 + rec * 3 + (v > avgVol * 1.25 ? 1 : 0) + (roundDist < roundStep * 0.12 ? 1.2 : 0) + (g.items.some(x => x.type === "pivot") ? 0.6 : 0)
    };
  });
  const spacing = Math.max(a * 0.6, price * 0.007);
  const pick = list => {
    const out = [];
    list.slice().sort((x, y) => y.score - x.score).forEach(x => {
      if (out.length >= 5) return;
      if (out.every(o => Math.abs(o.price - x.price) >= spacing)) out.push(x);
    });
    return out;
  };
  const sup = pick(scored.filter(x => x.price < price * 0.998)).sort((x, y) => y.price - x.price).slice(0, 3);
  const res = pick(scored.filter(x => x.price > price * 1.002)).sort((x, y) => x.price - y.price).slice(0, 3);
  return { supports: sup, resistances: res };
}

async function fetchKlines() {
  const urls = [
    "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=ETH_USDT&interval=4h&limit=300",
    "https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=4h&limit=300",
    "https://www.okx.com/api/v5/market/candles?instId=ETH-USDT&bar=4H&limit=300"
  ];
  for (const u of urls) {
    try {
      console.log("fetch", u.slice(0, 55));
      const r = await fetch(u, { headers: { "User-Agent": "eth-alert/1.0" } });
      if (!r.ok) { console.log("  http", r.status); continue; }
      const j = await r.json();
      if (Array.isArray(j) && j.length) {
        if (j[0].length === 8) return j.map(k => ({ t: +k[0] * 1000, o: +k[5], h: +k[3], l: +k[4], c: +k[2], v: +k[6] }));
        if (j[0].length >= 6) return j.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      }
      if (j && Array.isArray(j.data) && j.data.length) {
        return j.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
      }
    } catch (e) { console.log("  fail", String(e && e.message || e)); }
  }
  throw new Error("all price sources failed");
}

async function push(title, body) {
  const keys = String(process.env.BARK_KEY || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length) { console.log("BARK_KEY 未设置，跳过推送"); return false; }
  for (const k of keys) {
    const url = `https://api.day.app/${encodeURIComponent(k)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=ETH&level=timeSensitive&sound=alarm`;
    try {
      const r = await fetch(url);
      console.log("bark", r.status);
    } catch (e) { console.log("bark fail", String(e && e.message || e)); }
  }
  return true;
}

function analyze(candles) {
  const closes = candles.map(c => c.c);
  const last = candles.length - 1;
  const e200 = ema(closes, 200)[last];
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const bb = bollinger(closes, last, 20, 2);
  const price = closes[last];
  const levels = buildLevels(candles, price, a);
  let side = null;
  if (e200 && price > e200 && r <= 45 && price <= bb.lo) side = "long";
  if (e200 && price < e200 && r >= 55 && price >= bb.up) side = "short";
  if (!side) return { signal: false, price, rsi: r, atr: a, levels };
  const lvl = side === "long" ? levels.supports[0] : levels.resistances[0];
  if (!lvl || lvl.score < CONFIG.minScore) return { signal: false, price, note: "强位不足", rsi: r, atr: a };
  let stop = side === "long" ? lvl.price - 0.15 * a : lvl.price + 0.15 * a;
  let risk = Math.abs(price - stop);
  let widened = false;
  // 止损太近时不放弃：直接把止损拉到 minRisk，止盈同步按 2R 外推
  if (risk < CONFIG.minRisk) {
    risk = CONFIG.minRisk;
    stop = side === "long" ? price - risk : price + risk;
    widened = true;
  }
  if (risk > CONFIG.maxRiskAtr * a) return { signal: false, price, note: "止损距离不符", rsi: r, atr: a };
  const target = side === "long" ? price + CONFIG.rr * risk : price - CONFIG.rr * risk;
  const adds = CONFIG.addLevels.map(l => ({ level: l, price: side === "long" ? price - l * risk : price + l * risk }));
  return { signal: true, side, price, stop, target, adds, risk, widened, level: lvl, rsi: r, atr: a };
}

const fmt = v => Number(v).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const sideText = s => (s === "long" ? "做多" : "做空");

// ---------------- 状态与持仓 ----------------

function readState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8").replace(/^\uFEFF/, "")); } catch (e) { s = {}; }
  if (!Array.isArray(s.positions)) s.positions = [];
  if (typeof s.realizedUsd !== "number") s.realizedUsd = 0;
  if (typeof s.closedCount !== "number") s.closedCount = 0;
  if (typeof s.winCount !== "number") s.winCount = 0;
  if (!Array.isArray(s.notified10)) s.notified10 = [];
  if (typeof s.lastSignalTs !== "number") s.lastSignalTs = 0;
  return s;
}
function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

const totalEth = positions => positions.reduce((sum, p) => sum + p.entries.reduce((a, e) => a + e.size, 0), 0);
const avgEntry = p => p.entries.reduce((a, e) => a + e.px * e.size, 0) / p.entries.reduce((a, e) => a + e.size, 0);

function recomputeTarget(p) {
  const avg = avgEntry(p);
  p.target = p.side === "long" ? avg + CONFIG.rr * (avg - p.stop) : avg - CONFIG.rr * (p.stop - avg);
  return avg;
}

function openPosition(state, res, bar, size) {
  const id = `${bar.t}-${res.side}-${res.score.toFixed(2)}`;
  const p = {
    id, side: res.side, entries: [{ px: res.price, size }],
    stop: res.stop, risk: res.risk, target: res.target,
    score: res.score, big: res.score > CONFIG.highScore,
    openedAt: bar.t, signalTs: bar.t, addsDone: 0
  };
  recomputeTarget(p);
  state.positions.push(p);
  return p;
}

function updatePositions(state, bar) {
  const closed = [];
  for (const p of [...state.positions]) {
    const heldBars = (bar.t - p.openedAt) / BAR_MS;
    let exitPx = null, reason = null;
    if (p.side === "long") {
      if (bar.l <= p.stop) { exitPx = p.stop; reason = "stop"; }
      else if (bar.h >= p.target) { exitPx = p.target; reason = "target"; }
    } else {
      if (bar.h >= p.stop) { exitPx = p.stop; reason = "stop"; }
      else if (bar.l <= p.target) { exitPx = p.target; reason = "target"; }
    }
    if (exitPx === null && heldBars >= CONFIG.timeStopDays * 6) { exitPx = bar.c; reason = "time"; }

    if (exitPx !== null) {
      const avg = avgEntry(p);
      const sign = p.side === "long" ? 1 : -1;
      const size = p.entries.reduce((a, e) => a + e.size, 0);
      const gross = (exitPx - avg) * size * sign;
      const notionalIn = p.entries.reduce((a, e) => a + e.px * e.size, 0);
      const fee = (notionalIn + exitPx * size) * FEE;
      const usd = gross - fee;
      const r = usd / (p.risk * size); // 按本仓位自身风险的 R
      p.exitPx = exitPx; p.exitReason = reason; p.exitAt = bar.t; p.r = r; p.usd = usd;
      state.realizedUsd += usd;
      state.closedCount += 1;
      if (usd > 0) state.winCount += 1;
      closed.push(p);
      state.positions = state.positions.filter(x => x.id !== p.id);
      continue;
    }

    // 加仓：价格触及 0.25R / 0.35R
    for (let k = 0; k < CONFIG.addLevels.length; k++) {
      if (p.addsDone > k) continue;
      const level = p.side === "long"
        ? p.entries[0].px - CONFIG.addLevels[k] * p.risk
        : p.entries[0].px + CONFIG.addLevels[k] * p.risk;
      const hit = p.side === "long" ? bar.l <= level : bar.h >= level;
      if (!hit) continue;
      const unit = CONFIG.addSize * (p.big ? CONFIG.highMult : 1);
      if (totalEth(state.positions) + unit > CONFIG.maxEth) break;
      p.entries.push({ px: level, size: unit });
      p.addsDone += 1;
      recomputeTarget(p);
    }
  }
  return closed;
}

function positionLines(state) {
  if (!state.positions.length) return "持仓：无";
  return state.positions.map(p => {
    const avg = avgEntry(p);
    const size = p.entries.reduce((a, e) => a + e.size, 0);
    return `持仓：${sideText(p.side)} ${size} ETH @${fmt(avg)} 止损${fmt(p.stop)} 止盈${fmt(p.target)}${p.big ? "（高分×" + CONFIG.highMult + "）" : ""}`;
  }).join("\n");
}

// ---------------- 主流程 ----------------

async function main() {
  const state = readState();
  let candles;
  try { candles = await fetchKlines(); } catch (e) { console.error("取数失败:", e.message); process.exit(1); }
  const closedCandles = candles.slice(0, -1);
  const bar = closedCandles[closedCandles.length - 1];
  console.log("last closed bar", new Date(bar.t).toISOString(), "close", bar.c);

  const lines = [];
  const closedPositions = updatePositions(state, bar);
  for (const p of closedPositions) {
    const reasonText = { stop: "止损", target: "止盈", time: "满10天" }[p.exitReason] || p.exitReason;
    lines.push(`平仓 ${sideText(p.side)} ${p.entries.reduce((a, e) => a + e.size, 0)} ETH ${reasonText} ${p.r >= 0 ? "+" : ""}${p.r.toFixed(2)}R（$${p.usd.toFixed(0)}）`);
  }

  const res = analyze(closedCandles);
  let title = null;
  let action = null;

  if (res.signal) {
    const size = res.score > CONFIG.highScore ? CONFIG.highMult : 1;
    const sameBar = state.lastSignalTs === bar.t;
    if (sameBar) {
      action = { type: "dup", res, size };
    } else if (state.positions.length === 0) {
      const p = openPosition(state, res, bar, size);
      state.lastSignalTs = bar.t;
      action = { type: "open", res, size, pos: p };
    } else {
      const sameSide = state.positions.every(p => p.side === res.side);
      const canParallel = res.score > CONFIG.highScore
        && state.positions.length < CONFIG.maxPositions
        && sameSide
        && totalEth(state.positions) + size <= CONFIG.maxEth;
      if (canParallel) {
        const p = openPosition(state, res, bar, size);
        state.lastSignalTs = bar.t;
        action = { type: "parallel", res, size, pos: p };
      } else {
        state.lastSignalTs = bar.t;
        action = { type: "ignore", res, size, reason: "已有持仓且不满足并行条件" };
      }
    }
  }

  if (action && action.type === "open") {
    title = `ETH 4H ${sideText(res.side)}信号${res.score > CONFIG.highScore ? "·高分×" + CONFIG.highMult : ""}`;
    lines.push(`新开 ${sideText(res.side)} ${action.size} ETH @${fmt(res.price)}`);
    lines.push(`止损 ${fmt(res.stop)} / 止盈 ${fmt(res.target)}（${res.score.toFixed(1)} 分）${res.widened ? " · 止损已拉宽到 " + CONFIG.minRisk : ""}`);
    lines.push(`加仓 ${fmt(res.adds[0].price)} / ${fmt(res.adds[1].price)}`);
  } else if (action && action.type === "parallel") {
    title = `ETH 4H ${sideText(res.side)}信号·高分并行`;
    lines.push(`并行开仓 ${sideText(res.side)} ${action.size} ETH @${fmt(res.price)}（第 ${state.positions.length} 笔）`);
    lines.push(`止损 ${fmt(res.stop)} / 止盈 ${fmt(res.target)}（${res.score.toFixed(1)} 分）${res.widened ? " · 止损已拉宽到 " + CONFIG.minRisk : ""}`);
    lines.push(`加仓 ${fmt(res.adds[0].price)} / ${fmt(res.adds[1].price)}`);
  } else if (action && action.type === "ignore") {
    title = `ETH 4H ${sideText(res.side)}信号·未开仓`;
    lines.push(`出现 ${sideText(res.side)}信号（${res.score.toFixed(1)} 分），但${action.reason}`);
  } else if (action && action.type === "dup") {
    title = "ETH 4H · 同一根K线重复信号";
    lines.push(`同一根 K 线已处理过 ${sideText(res.side)}信号，不重复开仓`);
  } else if (closedPositions.length) {
    title = "ETH 4H · 平仓提醒";
    lines.push(`价格 ${fmt(res.price)} | RSI ${res.rsi != null ? res.rsi.toFixed(0) : "-"} | ATR ${res.atr != null ? res.atr.toFixed(0) : "-"}`);
  } else {
    title = "ETH 4H · 无信号";
    lines.push(`价格 ${fmt(res.price)}`);
    lines.push(`RSI ${res.rsi != null ? res.rsi.toFixed(0) : "-"} · ATR ${res.atr != null ? res.atr.toFixed(0) : "-"}`);
    lines.push(res.note || "条件未满足");
  }

  lines.push("");
  lines.push(positionLines(state));
  lines.push(`累计：已平 ${state.closedCount} 笔，胜 ${state.winCount} 笔，已实现 $${state.realizedUsd.toFixed(0)}`);

  // 持仓满 10 天提醒（每笔一次）
  for (const p of state.positions) {
    const heldBars = (bar.t - p.openedAt) / BAR_MS;
    if (heldBars >= CONFIG.timeStopDays * 6 && !state.notified10.includes(p.id)) {
      lines.push(`⚠️ ${sideText(p.side)}持仓已满 ${CONFIG.timeStopDays} 天，按规则应在本根收盘平仓`);
      state.notified10.push(p.id);
    }
  }

  await push(title, lines.join("\n"));
  writeState(state);
  console.log("pushed:", title);
  console.log(lines.join("\n"));
}

main().catch(e => { console.error(e); process.exit(1); });
