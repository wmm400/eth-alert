// ETH 4H 强位模型 · 云端提醒（GitHub Actions + Bark）
// 依赖：Node 18+（自带 fetch），无需 npm 包
const fs = require("fs");
const path = require("path");

const CONFIG = {
  minScore: 10,
  rr: 2.0,
  addLevels: [0.25, 0.35],
  minRisk: 20,
  maxRiskAtr: 3,
  timeStopDays: 10
};
const STATE_PATH = path.join(__dirname, "state.json");

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
  if (!lvl || lvl.score < CONFIG.minScore) return { signal: false, price, note: "强位不足" };
  const stop = side === "long" ? lvl.price - 0.15 * a : lvl.price + 0.15 * a;
  const risk = Math.abs(price - stop);
  if (risk < CONFIG.minRisk || risk > CONFIG.maxRiskAtr * a) return { signal: false, price, note: "止损距离不符" };
  const target = side === "long" ? price + CONFIG.rr * risk : price - CONFIG.rr * risk;
  const adds = CONFIG.addLevels.map(l => ({ level: l, price: side === "long" ? price - l * risk : price + l * risk }));
  return { signal: true, side, price, stop, target, adds, risk, level: lvl, rsi: r, atr: a };
}

const fmt = v => v.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch (e) { return { lastSignalTs: 0, openTime: 0, notified10: false }; }
}
function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

async function main() {
  const state = readState();
  let candles;
  try { candles = await fetchKlines(); } catch (e) { console.error("取数失败:", e.message); process.exit(1); }
  const closed = candles.slice(0, -1);
  const lastBar = closed[closed.length - 1];
  console.log("last closed bar", new Date(lastBar.t).toISOString(), "close", lastBar.c);
  const res = analyze(closed);

  let pushed = false;
  if (res.signal) {
    const s = res.side === "long" ? "做多" : "做空";
    const body = [
      `${s} 入场 ${fmt(res.price)}`,
      `止损 ${fmt(res.stop)}`,
      `止盈 ${fmt(res.target)}`,
      `加仓1 ${fmt(res.adds[0].price)}`,
      `加仓2 ${fmt(res.adds[1].price)}`,
      `强位 ${fmt(res.level.price)} (${res.level.score.toFixed(1)})`,
      `RSI ${res.rsi.toFixed(0)} ATR ${res.atr.toFixed(0)}`
    ].join("\n");
    pushed = await push(`ETH 4H ${s}信号`, body);
    if (state.lastSignalTs !== lastBar.t) {
      state.lastSignalTs = lastBar.t;
      state.openTime = Date.now();
      state.notified10 = false;
    }
    console.log("signal", s, res.price, res.stop, res.target);
  } else {
    const body = [
      `价格 ${fmt(res.price)}`,
      `RSI ${res.rsi != null ? res.rsi.toFixed(0) : "-"} · ATR ${res.atr != null ? res.atr.toFixed(0) : "-"}`,
      res.note || "条件未满足",
      `K线 ${new Date(lastBar.t).toISOString().slice(0, 16)} UTC`
    ].join("\n");
    pushed = await push("ETH 4H · 无信号", body);
    console.log("no signal:", res.note || "");
  }

  if (state.openTime && !state.notified10 && Date.now() - state.openTime >= CONFIG.timeStopDays * 864e5) {
    await push("ETH 持仓满 10 天", "按规则应在最近一根 4H 收盘平仓（若已开仓）。");
    state.notified10 = true;
    pushed = true;
  }

  writeState(state);
  console.log(pushed ? "pushed" : "nothing to push");
}

main().catch(e => { console.error(e); process.exit(1); });
