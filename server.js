// =============================================
// TRADE GENIE PRO v3.1 — PRODUCTION SERVER
// =============================================
const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "JkFNQiMO",
  clientId: process.env.ANGEL_CLIENT_ID || "V58776779",
  baseURL: "apiconnect.angelone.in",
  wsURL: "wss://smartapiws.angelone.in/smart-stream"
};
const TELEGRAM = { token: process.env.TELEGRAM_TOKEN || "", chatId: process.env.TELEGRAM_CHAT_ID || "" };
function sendTg(msg) { try { if (!TELEGRAM.token || !TELEGRAM.chatId) return; const p = JSON.stringify({ chat_id: TELEGRAM.chatId, text: "🧞 " + msg }); const r = https.request({ hostname: "api.telegram.org", path: `/bot${TELEGRAM.token}/sendMessage`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p) } }, () => {}); r.on("error", () => {}); r.write(p); r.end(); } catch (e) {} }

// ── GREEKS ──
const Greeks = {
  _pdf: x => Math.exp(-.5 * x * x) / Math.sqrt(2 * Math.PI),
  _cdf: x => { const L = Math.abs(x), k = 1 / (1 + .2316419 * L), w = 1 - Greeks._pdf(L) * (.3193815 * k - .3565638 * k ** 2 + 1.781478 * k ** 3 - 1.821256 * k ** 4 + 1.330274 * k ** 5); return x < 0 ? 1 - w : w; },
  compute: ({ S, K, T, r = .07, sigma = .2, type = "CE" }) => { S = +S; K = +K; T = +T; r = +r; sigma = +sigma; if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return { ok: false }; const sT = Math.sqrt(T), d1 = (Math.log(S / K) + (r + .5 * sigma * sigma) * T) / (sigma * sT), d2 = d1 - sigma * sT, Nd1 = Greeks._cdf(d1), Nd2 = Greeks._cdf(d2), nd1 = Greeks._pdf(d1), isC = String(type).toUpperCase().includes("C"); return { ok: true, delta: +(isC ? Nd1 : Nd1 - 1).toFixed(4), gamma: +(nd1 / (S * sigma * sT)).toFixed(6), vega: +(S * nd1 * sT / 100).toFixed(4), theta: +((-S * nd1 * sigma / (2 * sT) - (isC ? r * K * Math.exp(-r * T) * Nd2 : -r * K * Math.exp(-r * T) * Greeks._cdf(-d2))) / 365).toFixed(4) }; }
};

// ── INSTRUMENTS ──
const NSE_INDICES = ["99926000", "99926009", "99926037", "99926017", "99926013", "99926074"];
const BSE_INDICES = ["99919000", "99919016"];
const STOCKS = ["3045", "11536", "1333", "1594", "4963", "1660", "3787"];
let COM_TOKENS = [];
const COM_LABELS = ["CRUDEOIL", "NATURALGAS", "GOLDM", "GOLD", "SILVERM", "SILVER", "COPPER"];
const GLOBAL_SYMBOLS = [
  { symbol: "^GSPC", name: "S&P 500", flag: "🇺🇸" }, { symbol: "^DJI", name: "Dow Jones", flag: "🇺🇸" },
  { symbol: "^IXIC", name: "Nasdaq", flag: "🇺🇸" }, { symbol: "^FTSE", name: "FTSE 100", flag: "🇬🇧" },
  { symbol: "^N225", name: "Nikkei 225", flag: "🇯🇵" }, { symbol: "^HSI", name: "Hang Seng", flag: "🇭🇰" },
  { symbol: "^GDAXI", name: "DAX", flag: "🇩🇪" }, { symbol: "^STI", name: "Straits Times", flag: "🇸🇬" },
  { symbol: "NIFTY_50.NS", name: "GIFT Nifty (SGX)", flag: "🇮🇳" }
];
const NEWS_FEEDS = [
  { hostname: "www.moneycontrol.com", path: "/rss/marketreports.xml", source: "Moneycontrol" },
  { hostname: "economictimes.indiatimes.com", path: "/markets/rssfeeds/1977021501.cms", source: "Economic Times" },
  { hostname: "www.livemint.com", path: "/rss/markets", source: "LiveMint" }
];

// ── DATA ──
const DATA_DIR = path.join(__dirname, "data");
const CANDLE_DIR = path.join(DATA_DIR, "candles");
const SCRIP_PATH = path.join(DATA_DIR, "scripMaster.json");
const QUOTE_PATH = path.join(DATA_DIR, "lastQuotes.json");
[DATA_DIR, CANDLE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let SCRIP = { updatedAt: 0, rows: [] };
let QCACHE = { updatedAt: 0, byToken: {} };
try { if (fs.existsSync(QUOTE_PATH)) { QCACHE = JSON.parse(fs.readFileSync(QUOTE_PATH, "utf8")); if (!QCACHE?.byToken) QCACHE = { updatedAt: 0, byToken: {} }; } } catch (e) { QCACHE = { updatedAt: 0, byToken: {} }; }
let SESSION = { token: null, feedToken: null, updatedAt: 0 };
let RESOLVED_MCX = { updatedAt: 0, picked: [] };
const SSE_CLIENTS = new Map();

// ── HELPERS ──
function requestAngel(rp, method, headers, data) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: CONFIG.baseURL, path: rp, method, headers }, res => {
      let body = ""; res.on("data", c => body += c);
      res.on("end", () => { try { resolve({ statusCode: res.statusCode, body: body ? JSON.parse(body) : null }); } catch (e) { resolve({ statusCode: res.statusCode, body: { raw: body } }); } });
    }); req.on("error", reject); if (data) req.write(JSON.stringify(data)); req.end();
  });
}
function getHeaders(token) { return { Authorization: `Bearer ${token}`, "X-PrivateKey": CONFIG.apiKey, "Content-Type": "application/json", Accept: "application/json", "X-SourceID": "WEB", "X-UserType": "USER", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00" }; }
function httpGet(hostname, reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: "GET", headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 }, res => {
      let body = ""; res.on("data", c => body += c); res.on("end", () => resolve(body));
    }); req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject); req.end();
  });
}

// ── QUOTE CACHE ──
function cacheQuotes(list, exchange) {
  QCACHE.updatedAt = Date.now();
  for (const item of (list || [])) { const t = String(item?.symbolToken || item?.token || ""); if (!t) continue; QCACHE.byToken[t] = { exchange, name: item?.tradingSymbol || item?.tradingsymbol || null, ltp: +(item?.ltp || 0), raw: item, ts: Date.now() }; }
  try { fs.writeFileSync(QUOTE_PATH, JSON.stringify(QCACHE)); } catch (e) {}
}

// ── SCRIP MASTER ──
async function fetchScrip(force = false) {
  const now = Date.now(), maxAge = 6 * 3600000;
  if (!force && SCRIP.updatedAt && (now - SCRIP.updatedAt <= maxAge) && SCRIP.rows.length) return;
  try { if (fs.existsSync(SCRIP_PATH)) { const d = JSON.parse(fs.readFileSync(SCRIP_PATH, "utf8")); if (d?.rows?.length && !force && (now - d.updatedAt <= maxAge)) { SCRIP = d; return; } } } catch (e) {}
  try {
    const raw = await httpGet("margincalculator.angelbroking.com", "/OpenAPI_File/files/OpenAPIScripMaster.json");
    let rows = []; try { rows = JSON.parse(raw); if (!Array.isArray(rows)) rows = []; } catch (e) { rows = []; }
    SCRIP = { updatedAt: now, rows };
    try { fs.writeFileSync(SCRIP_PATH, JSON.stringify(SCRIP)); } catch (e) {}
  } catch (e) { console.log("ScripMaster fetch failed:", e.message); }
}
function findSymbol(symbol, exch = "NSE") {
  const sym = String(symbol).trim().toUpperCase(), seg = exch.toUpperCase();
  const hit = (SCRIP.rows || []).find(r => String(r.symbol || r.tradingsymbol || "").toUpperCase() === sym && String(r.exch_seg || r.exchange || "").toUpperCase() === seg);
  return hit ? { token: String(hit.token || ""), row: hit } : null;
}
function searchScrip(q, exch = "", limit = 20) {
  const query = String(q || "").trim().toUpperCase(), seg = exch.toUpperCase(), lim = Math.min(+limit || 20, 50);
  if (query.length < 2) return []; const out = [];
  for (const r of (SCRIP.rows || [])) { const s = String(r.symbol || r.tradingsymbol || "").toUpperCase(); if (!s) continue; if (seg && String(r.exch_seg || r.exchange || "").toUpperCase() !== seg) continue; if (s.includes(query)) { out.push({ symbol: r.symbol || r.tradingsymbol, token: String(r.token || ""), exch: r.exch_seg || r.exchange, name: r.name || r.symbolname, lotsize: r.lotsize, expiry: r.expiry }); if (out.length >= lim) break; } }
  return out;
}

// ══════════════════════════════════════════
// MCX RESOLVER — FIXED: picks FUTURES only
// Excludes CE/PE options explicitly
// ══════════════════════════════════════════
async function resolveMcx() {
  try {
    await fetchScrip(false);
    const today = new Date(), todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const parseExp = e => { try { e = String(e || "").trim(); if (!e) return null; if (e.includes("-")) return new Date(e); const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }; return new Date(+e.slice(5), months[e.slice(2, 5).toUpperCase()] ?? 0, +e.slice(0, 2)); } catch { return null; } };

    const picked = [], seen = new Set();
    for (const label of COM_LABELS) {
      // Find FUTURES contracts only — exclude options (CE/PE in symbol)
      const candidates = (SCRIP.rows || []).filter(r => {
        if (String(r.exch_seg || r.exchange || "").toUpperCase() !== "MCX") return false;
        const sym = String(r.symbol || r.tradingsymbol || "").toUpperCase();
        if (!sym) return false;
        // MUST contain the commodity name
        if (!sym.includes(label.toUpperCase())) return false;
        // MUST be futures — check instrumenttype contains FUT
        const itype = String(r.instrumenttype || r.instrument_type || "").toUpperCase();
        const hasFut = itype.includes("FUT") || sym.includes("FUT");
        // MUST NOT be an option — exclude CE/PE at end of symbol
        const isOption = /\d+(CE|PE)$/i.test(sym) || itype.includes("OPT") || itype.includes("CE") || itype.includes("PE");
        return hasFut && !isOption;
      });

      // Parse expiries, pick nearest future
      const parsed = candidates.map(r => ({ r, exp: parseExp(r.expiry) })).filter(x => x.exp && !isNaN(x.exp));
      const future = parsed.filter(x => x.exp >= todayStart);
      const sorted = (future.length ? future : parsed).sort((a, b) => a.exp - b.exp);
      const best = sorted[0]?.r;
      if (best) {
        const token = String(best.token || "");
        if (token && !seen.has(token)) {
          seen.add(token);
          picked.push({ label, token, symbol: best.symbol || best.tradingsymbol, expiry: best.expiry, lotsize: best.lotsize });
        }
      }
    }
    if (picked.length) {
      COM_TOKENS = picked.map(x => x.token);
      RESOLVED_MCX = { updatedAt: Date.now(), picked };
      console.log("MCX resolved:", picked.map(p => `${p.label}=${p.symbol}(${p.token})`).join(", "));
    }
  } catch (e) { console.log("MCX resolve error:", e.message); }
}

// ── FETCH QUOTES & CANDLES ──
async function fetchQuotes(token, exchange, tokens) {
  const res = await requestAngel("/rest/secure/angelbroking/market/v1/quote/", "POST", getHeaders(token), { mode: "FULL", exchangeTokens: { [exchange]: tokens } });
  const f = res?.body?.data?.fetched || []; if (f.length) cacheQuotes(f, exchange); return f;
}
async function fetchCandles(token, exchange, symbolToken, interval, fromdate, todate) {
  const raw = await requestAngel("/rest/secure/angelbroking/historical/v1/getCandleData", "POST", getHeaders(token), { exchange, symboltoken: String(symbolToken), interval, fromdate, todate });
  const d = raw?.body?.data; return Array.isArray(d) ? d.map(c => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] })) : [];
}

// ── CANDLE DISK CACHE ──
function candleKey(e, t, i) { return `${e}_${t}_${i}`.replace(/[^a-zA-Z0-9_]/g, "_"); }
function saveCandles(key, candles) { try { fs.writeFileSync(path.join(CANDLE_DIR, key + ".json"), JSON.stringify(candles)); } catch (e) {} }
function loadCandles(key) { try { return JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, key + ".json"), "utf8")); } catch (e) { return []; } }
function mergeCandles(old, fresh) { const m = new Map(); (old || []).forEach(c => { if (c.t) m.set(c.t, c); }); (fresh || []).forEach(c => { if (c.t) m.set(c.t, c); }); return [...m.values()].sort((a, b) => a.t < b.t ? -1 : 1); }
async function fetchCachedCandles(jwt, exchange, symbolToken, interval, fromdate, todate) {
  const key = candleKey(exchange, symbolToken, interval);
  const fresh = await fetchCandles(jwt, exchange, symbolToken, interval, fromdate, todate);
  const old = loadCandles(key);
  const merged = mergeCandles(old, fresh);
  if (merged.length) saveCandles(key, merged.slice(-2000));
  return merged.length ? merged : old;
}

// ── TECHNICAL INDICATORS ──
function ema(v, p) { if (!v || v.length < p) return null; const k = 2 / (p + 1); let e = v[0]; for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
function emaArr(v, p) { if (!v || v.length < p) return []; const k = 2 / (p + 1), o = []; let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = 0; i < v.length; i++) { if (i < p - 1) { o.push(null); continue; } if (i === p - 1) { o.push(e); continue; } e = v[i] * k + e * (1 - k); o.push(e); } return o; }
function rsi(cl, p = 14) { if (cl.length < p + 1) return null; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l += Math.abs(d); } let ag = g / p, al = l / p; for (let i = p + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p; } return al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2); }
function vwap(c) { let pv = 0, vol = 0; for (const x of c) { pv += (x.h + x.l + x.c) / 3 * (x.v || 0); vol += (x.v || 0); } return vol > 0 ? pv / vol : null; }
function bollinger(cl, p = 20, m = 2) { if (cl.length < p) return null; const sl = cl.slice(-p), mean = sl.reduce((a, b) => a + b, 0) / p, sd = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / p); return { upper: +(mean + m * sd).toFixed(2), middle: +mean.toFixed(2), lower: +(mean - m * sd).toFixed(2) }; }
function macd(cl, f = 12, s = 26, sig = 9) { const fe = emaArr(cl, f), se = emaArr(cl, s); if (!fe.length || !se.length) return null; const line = []; for (let i = 0; i < cl.length; i++) { if (fe[i] != null && se[i] != null) line.push(fe[i] - se[i]); else line.push(null); } const valid = line.filter(x => x != null); if (valid.length < sig) return null; const signal = ema(valid, sig); const last = valid[valid.length - 1]; return { line: +last.toFixed(2), signal: +signal.toFixed(2), histogram: +(last - signal).toFixed(2) }; }
function supertrend(candles, p = 10, m = 3) { if (candles.length < p + 1) return null; let ub = 0, lb = 0, trend = 1, st = 0; for (let i = p; i < candles.length; i++) { const atr = candles.slice(i - p, i).reduce((a, c, j) => { if (j === 0) return 0; const pc = candles[i - p + j - 1].c; return a + Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)); }, 0) / p; const hl2 = (candles[i].h + candles[i].l) / 2; const nub = hl2 + m * atr, nlb = hl2 - m * atr; ub = nlb > lb ? nlb : lb; lb = nub < ub ? nub : ub; if (candles[i].c > ub) trend = 1; else if (candles[i].c < lb) trend = -1; st = trend === 1 ? lb : ub; } return { value: +st.toFixed(2), trend: trend === 1 ? "BULLISH" : "BEARISH" }; }

// ── CANDLESTICK PATTERNS ──
function detectPatterns(candles) {
  if (!candles || candles.length < 3) return [];
  const pats = [], c0 = candles[candles.length - 1], c1 = candles[candles.length - 2], c2 = candles[candles.length - 3];
  const body0 = Math.abs(c0.c - c0.o), rng0 = c0.h - c0.l, up0 = c0.h - Math.max(c0.o, c0.c), lo0 = Math.min(c0.o, c0.c) - c0.l;
  if (rng0 > 0 && body0 / rng0 < .1) pats.push({ name: "Doji", sentiment: "Neutral" });
  if (lo0 > body0 * 2 && up0 < body0 * .5 && c0.c > c0.o) pats.push({ name: "Hammer", sentiment: "Bullish" });
  if (up0 > body0 * 2 && lo0 < body0 * .5 && c0.c < c0.o) pats.push({ name: "Shooting Star", sentiment: "Bearish" });
  if (c1.c < c1.o && c0.c > c0.o && c0.o <= c1.c && c0.c >= c1.o) pats.push({ name: "Bullish Engulfing", sentiment: "Bullish" });
  if (c1.c > c1.o && c0.c < c0.o && c0.o >= c1.c && c0.c <= c1.o) pats.push({ name: "Bearish Engulfing", sentiment: "Bearish" });
  if (c1.c < c1.o && c0.c > c0.o && c0.o > c1.c && c0.c < c1.o) pats.push({ name: "Bullish Harami", sentiment: "Bullish" });
  if (c1.c > c1.o && c0.c < c0.o && c0.o < c1.c && c0.c > c1.o) pats.push({ name: "Bearish Harami", sentiment: "Bearish" });
  return pats;
}

// ── MARKET REGIME + ANTI-WHIPSAW ──
function getRegime(candles) { if (!candles || candles.length < 25) return "COLLECTING"; const cl = candles.map(x => x.c), e5 = ema(cl.slice(-20), 5), e20 = ema(cl, 20); if (e5 == null || e20 == null) return "COLLECTING"; let trs = []; for (let i = 1; i < candles.length; i++) { const pc = candles[i - 1].c; trs.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc))); } const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.max(1, trs.slice(-14).length); return (Math.abs((e5 - e20) / e20 * 100) > .08 && (atr / cl[cl.length - 1] * 100) > .15) ? "TRENDING" : "SIDEWAYS"; }
function antiWhipsaw(candles) { if (!candles || candles.length < 30) return { signal: "HOLD", reason: "Not enough candles" }; const cl = candles.map(x => x.c), ef = ema(cl, 9), es = ema(cl, 21), vw = vwap(candles); if (ef == null || es == null || vw == null) return { signal: "HOLD", reason: "Indicator not ready" }; const last = candles[candles.length - 1], prev = candles[candles.length - 2]; if (Math.abs(last.c - vw) / vw < .0005) return { signal: "HOLD", reason: "VWAP chop zone", emaFast: ef, emaSlow: es, vwap: vw }; if (ef > es && last.c > vw && prev.c > vw) return { signal: "BUY", reason: "VWAP+EMA UP", emaFast: ef, emaSlow: es, vwap: vw }; if (ef < es && last.c < vw && prev.c < vw) return { signal: "SELL", reason: "VWAP+EMA DOWN", emaFast: ef, emaSlow: es, vwap: vw }; return { signal: "HOLD", reason: "No alignment", emaFast: ef, emaSlow: es, vwap: vw }; }

// ── SIGNAL ENGINES ──
function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return { atr: 0, atrPct: 0, trList: [] };
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    if (isFinite(tr)) trs.push(tr);
  }
  const slice = trs.slice(-period);
  const atr = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  const lastClose = candles[candles.length - 1]?.c || 0;
  const atrPct = lastClose ? (atr / lastClose) * 100 : 0;
  return { atr, atrPct, trList: trs };
}
function median(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// ── DATA-DRIVEN SCORE ENGINE (non-breaking) ──
// Returns: { signal, score(0-100), confidence, mode, risk, gates[], reasonSimple }
function scoreEngine(m, ind, ctx = {}) {
  const ltp = +(m?.ltp || 0);
  const isCommodity = !!ctx.commodity;
  const isIndex = !!ctx.isIndex;

  const emaFast = +(ind?.emaFast || 0), emaSlow = +(ind?.emaSlow || 0), vwap = +(ind?.vwap || 0);
  const rsi = +(ind?.rsi || 0);
  const macdHist = +(ind?.macdHist || 0);
  const regime = (ind?.regime || "UNKNOWN").toUpperCase();
  const { atr = 0, atrPct = 0, trList = [] } = ind?.atrPack || { atr: 0, atrPct: 0, trList: [] };

  const distVWAP = vwap ? (ltp - vwap) / vwap : 0;
  const emaSpread = ltp ? (emaFast - emaSlow) / ltp : 0;
  const volMedian = median(trList.slice(-50));
  const volSpike = volMedian > 0 ? (atr > volMedian * 1.8) : false;

  // Gates (NO-TRADE filters)
  const gates = [];
  const chopZone = Math.abs(distVWAP) < 0.0015 && Math.abs(emaSpread) < 0.0008;
  if (chopZone) gates.push({ key: "CHOP", ok: false, msg: "Price is stuck in a tight zone — wait for clear move." });
  if (volSpike) gates.push({ key: "VOL", ok: false, msg: "Volatility is too high — risk of sudden whipsaw." });

  // Macro risk (light): if global risk-off and local is weak, reduce bullish signals
  const riskOff = !!ctx.riskOff;
  if (riskOff) gates.push({ key: "RISK_OFF", ok: false, msg: "Market mood looks risk-off — avoid aggressive entries." });

  // Trend + momentum scoring
  // Trend direction: emaFast vs emaSlow, and distance from VWAP
  const trendDir = emaFast && emaSlow ? (emaFast > emaSlow ? 1 : emaFast < emaSlow ? -1 : 0) : 0;

  let score = 50;

  // Trend strength
  score += clamp(emaSpread * 6000, -20, 20);

  // VWAP bias
  score += clamp(distVWAP * 4000, -15, 15);

  // Momentum bias (RSI)
  if (rsi) {
    if (rsi > 60) score += 8;
    else if (rsi < 40) score -= 8;
  }

  // MACD histogram bias
  if (macdHist) score += clamp(macdHist * 2000, -10, 10);

  // Regime bias: trend-follow signals are weaker in sideways regimes
  if (regime.includes("SIDE")) score -= 6;
  if (regime.includes("TREND")) score += 6;

  // Commodity risk bump
  if (isCommodity) score -= 2;

  // Convert to action + confidence
  score = clamp(Math.round(score), 0, 100);

  // If any gate failed, force NO_TRADE unless score is extreme and we allow "WATCH"
  const hasHardGate = gates.some(g => g.ok === false);
  let signal = "HOLD";
  if (!hasHardGate) {
    if (score >= 70) signal = "BUY";
    else if (score <= 30) signal = "SELL";
  } else {
    // Still allow WATCH direction for UI, but no "Ready Trade"
    if (score >= 75) signal = "HOLD";
    else if (score <= 25) signal = "HOLD";
    else signal = "HOLD";
  }

  // risk/mode: derive from atrPct and score distance
  let risk = Math.round(clamp((atrPct * 10) + Math.abs(score - 50), 0, 100));
  if (isCommodity) risk = clamp(risk + 8, 0, 100);
  const mode = risk < 45 ? "MODE1" : "MODE2";

  const confidence = score >= 80 || score <= 20 ? "HIGH" : score >= 70 || score <= 30 ? "MED" : "LOW";

  // Simple language reason
  let reasonSimple = "Wait — setup not clear yet.";
  if (signal === "BUY") reasonSimple = "Up move looks stronger — buy only after confirmation.";
  else if (signal === "SELL") reasonSimple = "Down move looks stronger — buy PE/put only after confirmation.";
  if (hasHardGate) reasonSimple = gates[0]?.msg || reasonSimple;

  return { signal, score, confidence, mode, risk, gates, reasonSimple, trendDir, distVWAP, atr, atrPct };
}

// Keeps old signature for compatibility
function signalEngine(i, commodity = false) {
  // Minimal fallback score based on price change if no indicators passed
  const alpha = i.changePct > .6 ? "BUY" : i.changePct < -.6 ? "SELL" : "HOLD";
  let risk = Math.abs(i.changePct) * 8 + (i.range / (i.ltp || 1)) * 100 * 2;
  if (commodity) risk += 12;
  risk = Math.min(100, Math.round(risk));
  const mode = risk < 40 ? "MODE1" : "MODE2";
  return { signal: alpha, mode, risk, score: 50, confidence: "LOW", gates: [], reasonSimple: "" };
}
const SIG_BUF = { byToken: {}, ticks: 2 };
function confirmSig(token, raw) { const t = String(token || ""), s = (raw || "HOLD").toUpperCase(); if (!t) return { signal: s }; const st = SIG_BUF.byToken[t] || { committed: "HOLD", pending: "HOLD", cnt: 0 }; if (s === st.committed) { st.pending = s; st.cnt = 0; SIG_BUF.byToken[t] = st; return { signal: st.committed }; } if (s === st.pending) st.cnt++; else { st.pending = s; st.cnt = 1; } if (st.cnt >= SIG_BUF.ticks) { st.committed = st.pending; st.cnt = 0; } SIG_BUF.byToken[t] = st; return { signal: st.committed }; }
function suggestOption(name, ltp, dir, isIdx) { const p = +ltp; if (!(p > 0)) return null; const step = isIdx ? 50 : p < 200 ? 5 : p < 500 ? 10 : p < 1000 ? 20 : p < 2000 ? 50 : 100; const ot = dir === "BUY" ? "CE" : "PE"; let strike = Math.round(p / step) * step; if (ot === "CE" && strike < p) strike += step; if (ot === "PE" && strike > p) strike -= step; return { optionType: ot, strike, suggested: `${String(name || "").replace(/-EQ$/i, "").trim()} ${strike} ${ot}` }; }
function enrichEngine(m, eng) {
  const ltp = +(m?.ltp || 0);
  const rawSig = (eng?.signal || "HOLD").toUpperCase();
  const buf = confirmSig(m?.token, rawSig);
  const sig = (buf.signal || rawSig).toUpperCase();

  const mode = eng?.mode || "MODE1";
  const isIdx = NSE_INDICES.includes(String(m?.token || ""));
  const isCommodity = String(m?.exchange || "").toUpperCase() === "MCX";

  // Dynamic risk sizing based on ATR (fallback to % if ATR unavailable)
  const atr = +(eng?.atr || 0);
  const base = atr > 0 ? atr : (ltp * (mode === "MODE2" ? 0.008 : 0.005));
  const slMult = mode === "MODE2" ? 1.2 : 1.0;
  const t1Mult = mode === "MODE2" ? 2.2 : 1.6;
  const t2Mult = mode === "MODE2" ? 3.2 : 2.4;

  let trade = "WAIT";
  let tgt = null, tgt2 = null, sl = null, opt = null;
  if (sig === "BUY") {
    trade = isIdx ? "BUY CE (Index)" : isCommodity ? "BUY CALL (MCX)" : `BUY ${m.name}`;
    sl = ltp ? +(ltp - base * slMult).toFixed(2) : null;
    tgt = ltp ? +(ltp + base * t1Mult).toFixed(2) : null;
    tgt2 = ltp ? +(ltp + base * t2Mult).toFixed(2) : null;
    opt = suggestOption(m?.name, ltp, "BUY", isIdx);
  } else if (sig === "SELL") {
    trade = isIdx ? "BUY PE (Index)" : isCommodity ? "BUY PUT (MCX)" : `SELL ${m.name}`;
    sl = ltp ? +(ltp + base * slMult).toFixed(2) : null;
    tgt = ltp ? +(ltp - base * t1Mult).toFixed(2) : null;
    tgt2 = ltp ? +(ltp - base * t2Mult).toFixed(2) : null;
    opt = suggestOption(m?.name, ltp, "SELL", isIdx);
  }

  // Edge / confidence fallback
  const score = isFinite(+eng?.score) ? +eng.score : 50;
  const confidence = eng?.confidence || (score >= 80 || score <= 20 ? "HIGH" : score >= 70 || score <= 30 ? "MED" : "LOW");
  const edge = eng?.edge || (score >= 75 || score <= 25 ? "POSITIVE" : score >= 65 || score <= 35 ? "NEUTRAL" : "NEGATIVE");

  const rr = (sl != null && tgt != null) ? +((Math.abs(tgt - ltp)) / (Math.abs(ltp - sl) || 1)).toFixed(2) : null;

  // Prefer simple language reason if present
  const reason = (eng?.reason && String(eng.reason).trim()) ? eng.reason : (eng?.reasonSimple || "");

  return {
    ...eng,
    signal: sig,
    score,
    confidence,
    edge,
    trade,
    projectedTarget: tgt,
    projectedTarget2: tgt2,
    stopLoss: sl,
    rr,
    optionSuggestion: opt,
    reason
  };
}

function buildMarketData(item, exchange) { const ltp = +item.ltp || 0, close = +item.close || ltp, high = +item.high || ltp, low = +item.low || ltp, open = +item.open || ltp, change = ltp - close, changePct = close ? ((ltp - close) / close) * 100 : 0; return { name: item.tradingSymbol || "Unknown", token: item.symbolToken, exchange, ltp, open, high, low, close, change: +change.toFixed(2), changePct: +changePct.toFixed(2), range: +(high - low).toFixed(2) }; }

// ── MONTE CARLO ──
function computeMC(closes, days, paths) { const rets = []; for (let i = 1; i < closes.length; i++) { const r = Math.log(closes[i] / closes[i - 1]); if (isFinite(r)) rets.push(r); } if (rets.length < 20) return { ok: false }; const mu = rets.reduce((a, b) => a + b, 0) / rets.length, sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1)); const S0 = closes[closes.length - 1], nS = Math.max(5, +days || 20), nP = Math.min(3000, Math.max(300, +paths || 1000)); let wU = 0, wD = 0, finals = []; for (let p = 0; p < nP; p++) { let S = S0; for (let k = 0; k < nS; k++) { const u1 = Math.random() || 1e-9, u2 = Math.random() || 1e-9; S *= Math.exp((mu - .5 * sd * sd) + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)); } finals.push(S); if (S >= S0 * 1.005) wU++; if (S <= S0 * .995) wD++; } finals.sort((a, b) => a - b); const pct = q => finals[Math.floor(q * (finals.length - 1))]; return { ok: true, S0, stats: { winUp0_5: +(wU / nP * 100).toFixed(2), winDown0_5: +(wD / nP * 100).toFixed(2), p10: +pct(.1).toFixed(2), p50: +pct(.5).toFixed(2), p90: +pct(.9).toFixed(2) } }; }

// ── REAL EMA BACKTEST ──
const BT_CACHE = {}, BT_TTL = 3 * 60000;
function runBacktest(candles, fastP = 9, slowP = 21) {
  if (!candles || candles.length < slowP + 10) return { ok: false, error: "Not enough candles (" + (candles?.length || 0) + ")" };
  const cl = candles.map(c => c.c), fe = emaArr(cl, fastP), se = emaArr(cl, slowP), trades = []; let pos = null;
  for (let i = slowP + 1; i < cl.length; i++) { const fp = fe[i - 1], sp = se[i - 1], fc = fe[i], sc = se[i]; if (fp == null || sp == null || fc == null || sc == null) continue; if (fp <= sp && fc > sc) { if (pos && pos.type === "SELL") { trades.push({ type: "SELL", entry: pos.entry, exit: cl[i], pnl: pos.entry - cl[i] }); pos = null; } if (!pos) pos = { type: "BUY", entry: cl[i] }; } if (fp >= sp && fc < sc) { if (pos && pos.type === "BUY") { trades.push({ type: "BUY", entry: pos.entry, exit: cl[i], pnl: cl[i] - pos.entry }); pos = null; } if (!pos) pos = { type: "SELL", entry: cl[i] }; } }
  if (pos) trades.push({ type: pos.type, entry: pos.entry, exit: cl[cl.length - 1], pnl: pos.type === "BUY" ? cl[cl.length - 1] - pos.entry : pos.entry - cl[cl.length - 1], open: true });
  if (!trades.length) return { ok: true, totalTrades: 0, winRate: 0, signal: "HOLD", message: "No crossovers" };
  const wins = trades.filter(t => t.pnl > 0).length, wr = +(wins / trades.length * 100).toFixed(1), tp = trades.reduce((a, t) => a + t.pnl, 0);
  const lf = fe[fe.length - 1], ls = se[se.length - 1], r = rsi(cl, 14);
  let sig = "HOLD"; if (lf > ls) sig = "BUY"; else if (lf < ls) sig = "SELL";
  let conf = "MEDIUM"; if (sig === "BUY" && r > 50 && r < 70) conf = "HIGH"; else if (sig === "SELL" && r < 50 && r > 30) conf = "HIGH"; else if ((sig === "BUY" && r > 70) || (sig === "SELL" && r < 30)) conf = "OVERBOUGHT/OVERSOLD";
  const bb = bollinger(cl); const mc = macd(cl); const st = supertrend(candles); const pats = detectPatterns(candles);
  return { ok: true, ltp: cl[cl.length - 1], strategy: `EMA(${fastP}/${slowP})`, totalTrades: trades.length, wins, losses: trades.length - wins, winRate: wr, avgPnl: +(tp / trades.length).toFixed(2), totalPnl: +tp.toFixed(2), signal: sig, confidence: conf, rsi: r, emaFast: +lf.toFixed(2), emaSlow: +ls.toFixed(2), bollinger: bb, macd: mc, supertrend: st, patterns: pats };
}

// ── NEXT DAY WATCHLIST ──
function buildNextDayWatchlist(indices, stocks) {
  const watchlist = [];
  const all = [].concat(indices || [], stocks || []);
  for (const item of all) {
    const eng = item.engine || {};
    const sig = (eng.signal || "HOLD").toUpperCase();
    if (sig === "HOLD") continue;
    const score = (sig === "BUY" ? 1 : -1) * Math.abs(item.changePct || 0);
    watchlist.push({ name: item.name, ltp: item.ltp, signal: sig, changePct: item.changePct, trade: eng.trade, option: eng.optionSuggestion?.suggested || null, target: eng.projectedTarget, sl: eng.stopLoss, score: Math.abs(score) });
  }
  watchlist.sort((a, b) => b.score - a.score);
  return watchlist.slice(0, 10);
}


// ── SMART ALERTS (Advance warnings with hold-confirmation) ──
const ALERT_STATE = { byKey: {}, holdMs: 120000, cooldownMs: 12 * 60 * 1000 };

function computeLevelsFromCandles(candles, lookback = 12) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const slice = candles.slice(-lookback);
  const highs = slice.map(c => c.h);
  const lows = slice.map(c => c.l);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const last = slice[slice.length - 1];
  return { resistance, support, lastClose: last?.c || 0 };
}

function buildBreakoutAlert(m, ind, levels, ctx = {}) {
  const ltp = +(m?.ltp || 0);
  if (!ltp || !levels) return null;

  const { atrPct = 0 } = ind || {};
  const rangePct = ltp ? ((levels.resistance - levels.support) / ltp) * 100 : 0;

  // Compression heuristic: tight range + relatively low ATR%
  const compression = rangePct > 0 && rangePct < 0.8 && atrPct < 0.9;
  if (!compression) return null;

  // Buffer based on volatility
  const bufferPct = clamp(atrPct ? atrPct * 0.12 : 0.08, 0.05, 0.25) / 100;
  const upTrigger = +(levels.resistance * (1 + bufferPct)).toFixed(2);
  const dnTrigger = +(levels.support * (1 - bufferPct)).toFixed(2);

  // Proximity check: only show watch when near trigger zone
  const nearUp = (upTrigger - ltp) / upTrigger <= 0.003; // within 0.3%
  const nearDn = (ltp - dnTrigger) / dnTrigger <= 0.003;

  let dir = null, trigger = null;
  if (nearUp && ltp < upTrigger) { dir = "UP"; trigger = upTrigger; }
  else if (nearDn && ltp > dnTrigger) { dir = "DOWN"; trigger = dnTrigger; }
  else return null;

  const isIdx = !!ctx.isIndex;
  const isCommodity = !!ctx.commodity;
  const action = dir === "UP"
    ? (isIdx ? "Buy CE" : isCommodity ? "Buy CALL (CE)" : "Buy CE")
    : (isIdx ? "Buy PE" : isCommodity ? "Buy PUT (PE)" : "Buy PE");

  // Dynamic SL / targets from ATR
  const atr = +(ind?.atr || 0) || (ltp * 0.005);
  const sl = dir === "UP" ? +(trigger - atr * 1.1).toFixed(2) : +(trigger + atr * 1.1).toFixed(2);
  const t1 = dir === "UP" ? +(trigger + atr * 1.8).toFixed(2) : +(trigger - atr * 1.8).toFixed(2);
  const t2 = dir === "UP" ? +(trigger + atr * 2.6).toFixed(2) : +(trigger - atr * 2.6).toFixed(2);

  // Strength score from engine score + compression quality
  const baseScore = isFinite(+ind?.score) ? +ind.score : 50;
  const strength = clamp(Math.round(baseScore + (0.8 - rangePct) * 10), 0, 100);

  return {
    type: "BREAKOUT_SETUP",
    title: `${m.name} – Breakout setup building`,
    segment: isCommodity ? "MCX" : isIdx ? "INDEX" : "STOCK",
    token: String(m.token || ""),
    exchange: m.exchange,
    direction: dir,
    action,
    trigger,
    holdSeconds: Math.round((ALERT_STATE.holdMs || 120000) / 1000),
    sl,
    t1,
    t2,
    strength
  };
}

function updateHoldStatus(key, alert, ltp) {
  const now = Date.now();
  const st = ALERT_STATE.byKey[key] || { status: "WATCH", startedAt: 0, lastReadyAt: 0, lastSeen: 0 };
  st.lastSeen = now;

  // Cooldown after READY to avoid spam
  if (st.lastReadyAt && (now - st.lastReadyAt) < ALERT_STATE.cooldownMs) {
    st.status = "COOLDOWN";
    ALERT_STATE.byKey[key] = st;
    return { status: "COOLDOWN", progress: 100 };
  }

  const dir = alert.direction;
  const trigger = +alert.trigger;

  const crossed = dir === "UP" ? (ltp >= trigger) : (ltp <= trigger);

  if (!crossed) {
    st.status = "WATCH";
    st.startedAt = 0;
    ALERT_STATE.byKey[key] = st;
    return { status: "WATCH", progress: 0 };
  }

  if (!st.startedAt) {
    st.startedAt = now;
    st.status = "CONFIRMING";
  } else {
    st.status = "CONFIRMING";
  }

  const elapsed = now - st.startedAt;
  const progress = clamp(Math.round((elapsed / ALERT_STATE.holdMs) * 100), 0, 100);

  if (elapsed >= ALERT_STATE.holdMs) {
    st.status = "READY";
    st.lastReadyAt = now;
    st.startedAt = 0;
    ALERT_STATE.byKey[key] = st;
    return { status: "READY", progress: 100 };
  }

  ALERT_STATE.byKey[key] = st;
  return { status: "CONFIRMING", progress };
}

function buildSmartAlerts(universe, ctxByKey = {}) {
  const alerts = [];
  for (const m of (universe || [])) {
    const keyBase = `${m.exchange || ""}:${m.token || ""}`;
    const ind = m._indicators || {};
    const levels = m._levels || null;
    const ctx = ctxByKey[keyBase] || {};
    const a = buildBreakoutAlert(m, ind, levels, ctx);
    if (!a) continue;

    const stateKey = `${keyBase}:BREAKOUT:${a.direction}`;
    const hold = updateHoldStatus(stateKey, a, +(m.ltp || 0));
    a.status = hold.status;
    a.progress = hold.progress;

    // Simple message for UI (no jargon)
    if (a.status === "WATCH") a.message = `${a.action} only if price stays ${a.direction === "UP" ? "above" : "below"} ${a.trigger} for ${a.holdSeconds} sec.`;
    else if (a.status === "CONFIRMING") a.message = `Confirming… holding ${a.direction === "UP" ? "above" : "below"} ${a.trigger} (${a.progress}%).`;
    else if (a.status === "READY") a.message = `Confirmed ✅ ${a.action} now. Trigger held for ${a.holdSeconds} sec.`;
    else a.message = `Cooldown — wait for next clean setup.`;

    alerts.push(a);
  }

  // Sort: READY first, then CONFIRMING, then WATCH; by strength
  const rank = (st) => st === "READY" ? 0 : st === "CONFIRMING" ? 1 : st === "WATCH" ? 2 : 3;
  alerts.sort((a, b) => (rank(a.status) - rank(b.status)) || (b.strength - a.strength));
  return alerts.slice(0, 20);
}

// ── GLOBAL INDICES ──
const GLOBAL_CACHE = { data: [], ts: 0 };
async function fetchGlobal() {
  if (Date.now() - GLOBAL_CACHE.ts < 60000 && GLOBAL_CACHE.data.length) return GLOBAL_CACHE.data;
  const results = [];
  for (const g of GLOBAL_SYMBOLS) {
    try {
      // For GIFT Nifty, use a different approach
      let sym = g.symbol;
      if (sym === "NIFTY_50.NS") sym = "^NSEI"; // Try NSE Nifty from Yahoo
      const raw = await httpGet("query1.finance.yahoo.com", `/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`);
      const j = JSON.parse(raw); const meta = j?.chart?.result?.[0]?.meta;
      if (meta) { const ltp = meta.regularMarketPrice, prev = meta.chartPreviousClose; results.push({ symbol: g.symbol, name: g.name, flag: g.flag, ltp: +ltp.toFixed(2), change: +(ltp - prev).toFixed(2), changePct: +((ltp - prev) / prev * 100).toFixed(2), currency: meta.currency }); }
      else results.push({ symbol: g.symbol, name: g.name, flag: g.flag, error: "No data" });
    } catch (e) { results.push({ symbol: g.symbol, name: g.name, flag: g.flag, error: e.message }); }
  }
  GLOBAL_CACHE.data = results; GLOBAL_CACHE.ts = Date.now(); return results;
}

// ── NEWS ──
const NEWS_CACHE = { items: [], ts: 0 };
function parseRSS(xml, source) { const items = [], rx = /<item>([\s\S]*?)<\/item>/g; let m; while ((m = rx.exec(xml)) !== null) { const c = m[1]; const title = (c.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/) || c.match(/<title>(.*?)<\/title>/) || [])[1] || ""; const link = (c.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ""; const pubDate = (c.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || ""; const desc = (c.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/) || c.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || ""; if (title.trim()) items.push({ title: title.trim(), link: link.trim(), pubDate: pubDate.trim(), description: desc.replace(/<[^>]*>/g, "").trim().slice(0, 200), source }); } return items; }
async function fetchNews() { if (Date.now() - NEWS_CACHE.ts < 120000 && NEWS_CACHE.items.length) return NEWS_CACHE.items; let all = []; for (const f of NEWS_FEEDS) { try { const xml = await httpGet(f.hostname, f.path); all = all.concat(parseRSS(xml, f.source)); } catch (e) {} } all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)); NEWS_CACHE.items = all.slice(0, 40); NEWS_CACHE.ts = Date.now(); return NEWS_CACHE.items; }

// ── WEBSOCKET ──
let WS_CONN = null, WS_TIMER = null;
function connectWS() { if (!SESSION.token || !SESSION.feedToken) return; try { const WebSocket = require("ws"); if (WS_CONN) try { WS_CONN.close(); } catch (e) {} WS_CONN = new WebSocket(CONFIG.wsURL, { headers: { Authorization: `Bearer ${SESSION.token}`, "x-api-key": CONFIG.apiKey, "x-client-code": CONFIG.clientId, "x-feed-token": SESSION.feedToken } }); WS_CONN.on("open", () => { console.log("🔌 WS connected"); const sub = { correlationID: "tg_" + Date.now(), action: 1, params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: NSE_INDICES.concat(STOCKS) }] } }; if (COM_TOKENS.length) sub.params.tokenList.push({ exchangeType: 5, tokens: COM_TOKENS }); if (BSE_INDICES.length) sub.params.tokenList.push({ exchangeType: 3, tokens: BSE_INDICES }); WS_CONN.send(JSON.stringify(sub)); }); WS_CONN.on("message", data => { if (!(data instanceof Buffer) || data.length < 35) return; try { const token = data.toString("ascii", 2, 27).replace(/\0/g, "").trim(); const ltp = data.length >= 43 ? Number(data.readBigInt64LE(35)) / 100 : null; if (!token || !isFinite(ltp)) return; let open = null, high = null, low = null, close = null; if (data.length >= 91) { open = Number(data.readBigInt64LE(59)) / 100; high = Number(data.readBigInt64LE(67)) / 100; low = Number(data.readBigInt64LE(75)) / 100; close = Number(data.readBigInt64LE(83)) / 100; } const tick = { token, ltp, open, high, low, close, ts: Date.now() }; QCACHE.byToken[token] = { ...(QCACHE.byToken[token] || {}), ltp, ts: tick.ts }; broadcastSSE("tick", tick); } catch (e) {} }); WS_CONN.on("close", () => { WS_CONN = null; if (SESSION.token) WS_TIMER = setTimeout(connectWS, 5000); }); WS_CONN.on("error", e => { console.log("WS error:", e.message); }); } catch (e) { console.log("WS init failed:", e.message); } }
function broadcastSSE(event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const [id, res] of SSE_CLIENTS) { try { res.write(msg); } catch (e) { SSE_CLIENTS.delete(id); } } }

// ══════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════
app.get("/api/health", (_, res) => res.json({ ok: true, v: "3.1" }));
app.get("/api/status", (_, res) => res.json({ ok: true, v: "3.1", loggedIn: !!SESSION.token, ws: !!WS_CONN, mcx: RESOLVED_MCX?.picked?.length || 0 }));
app.get("/api/session/status", (_, res) => res.json({ ok: true, loggedIn: !!SESSION.token }));
app.get("/api/scrip/find", async (req, res) => { await fetchScrip(); const h = findSymbol(req.query.symbol, req.query.exch || "NSE"); res.json({ ok: true, found: !!h, ...(h || {}) }); });
app.get("/api/scrip/search", async (req, res) => { await fetchScrip(); res.json({ ok: true, results: searchScrip(req.query.q, req.query.exch, req.query.limit) }); });
app.get("/api/mcx/resolved", (_, res) => res.json({ ok: true, resolved: RESOLVED_MCX }));
app.get("/api/mcx/ltp", async (req, res) => { try { const jwt = SESSION?.token; if (!jwt) return res.status(401).json({ ok: false }); const picked = RESOLVED_MCX?.picked || []; if (!picked.length) return res.json({ ok: true, data: [] }); const q = await fetchQuotes(jwt, "MCX", picked.map(p => p.token)); const map = new Map((q || []).map(x => [String(x.symbolToken || x.token), x])); res.json({ ok: true, data: picked.map(p => { const x = map.get(p.token); const ltp = x ? +(x.ltp || 0) : null; const close = x ? +(x.close || ltp) : null; return { ...p, ltp, open: x ? +x.open : null, high: x ? +x.high : null, low: x ? +x.low : null, close, change: ltp && close ? +(ltp - close).toFixed(2) : null, changePct: ltp && close ? +((ltp - close) / close * 100).toFixed(2) : null }; }) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
app.post("/api/options/greeks", (req, res) => { const { S, K, T_days, r, sigma, type } = req.body || {}; res.json(Greeks.compute({ S, K, T: (+T_days) / 365, r, sigma, type })); });
app.get("/api/global-indices", async (_, res) => { try { res.json({ ok: true, data: await fetchGlobal() }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get("/api/news", async (_, res) => { try { res.json({ ok: true, data: await fetchNews() }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const id = Date.now() + Math.random();
  SSE_CLIENTS.set(id, res);

  res.write(`event: connected\ndata: {}\n\n`);

  // Heartbeat to keep Render/Proxies from closing idle SSE
  const hb = setInterval(() => {
    try { res.write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`); } catch (e) {}
  }, 25000);

  req.on("close", () => {
    clearInterval(hb);
    SSE_CLIENTS.delete(id);
  });
});


// ── BACKTEST (FIXED symbol resolution) ──
app.post("/api/backtest/stock", async (req, res) => {
  try {
    const { symbol, exchange = "NSE", jwtToken, fast = 9, slow = 21 } = req.body || {};
    const sym = String(symbol || "").trim().toUpperCase(); if (!sym) return res.status(400).json({ ok: false, error: "symbol required" });
    const jwt = jwtToken || SESSION?.token; if (!jwt) return res.status(401).json({ ok: false, error: "Not logged in" });
    const ck = `${exchange}:${sym}:${fast}:${slow}`; const cached = BT_CACHE[ck]; if (cached && (Date.now() - cached.ts) < BT_TTL) return res.json({ ok: true, cached: true, ...cached.data });
    await fetchScrip();
    let hit = null; for (const v of [sym + "-EQ", sym, sym + "-BE"]) { hit = findSymbol(v, exchange); if (hit) break; }
    if (!hit) return res.json({ ok: false, error: `Symbol ${sym} not found. Try ${sym}-EQ` });
    const now = new Date(), to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} 15:30`;
    const fr = new Date(now.getTime() - 30 * 86400000), from = `${fr.getFullYear()}-${String(fr.getMonth() + 1).padStart(2, "0")}-${String(fr.getDate()).padStart(2, "0")} 09:15`;
    const candles = await fetchCachedCandles(jwt, exchange, hit.token, "FIFTEEN_MINUTE", from, to);
    if (!candles.length) return res.json({ ok: false, error: "No candle data for " + sym + ". Try during market hours — data gets cached for offline use." });
    const result = runBacktest(candles, +fast, +slow); if (!result.ok) return res.json({ ok: false, error: result.error });
    const data = { symbol: sym, exchange, token: hit.token, candleCount: candles.length, ...result };
    BT_CACHE[ck] = { ts: Date.now(), data }; return res.json({ ok: true, ...data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── MC (FIXED: uses selected stock token, not hardcoded index) ──
app.post("/api/backtest/montecarlo", async (req, res) => {
  try {
    const { token: t, symbol, exchange = "NSE", jwtToken, days = 20, paths = 1000 } = req.body || {};
    const jwt = jwtToken || SESSION?.token; if (!jwt) return res.status(400).json({ ok: false, error: "Login required" });
    let symbolToken = t;
    // If symbol name passed instead of token, resolve it
    if (!symbolToken && symbol) {
      await fetchScrip();
      const hit = findSymbol(symbol + "-EQ", exchange) || findSymbol(symbol, exchange);
      if (hit) symbolToken = hit.token;
    }
    if (!symbolToken) return res.status(400).json({ ok: false, error: "token or symbol required" });
    const now = new Date(), to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} 15:30`;
    const fr = new Date(now.getTime() - 14 * 86400000), from = `${fr.getFullYear()}-${String(fr.getMonth() + 1).padStart(2, "0")}-${String(fr.getDate()).padStart(2, "0")} 09:15`;
    const candles = await fetchCachedCandles(jwt, exchange, symbolToken, "FIFTEEN_MINUTE", from, to);
    const closes = candles.map(c => c.c).filter(isFinite);
    if (closes.length < 30) return res.json({ ok: false, error: "Not enough data (" + closes.length + " closes)" });
    const out = computeMC(closes, days, paths);
    if (!out.ok) return res.json({ ok: false, error: "MC failed" });
    return res.json({ ok: true, exchange, token: symbolToken, S0: out.S0, stats: out.stats });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── MAIN ANGEL ROUTE ──
app.post("/api/angel", async (req, res) => {
  const { action, mpin, totp, token } = req.body;
  try {
    if (action === "login") {
      const login = await requestAngel("/rest/auth/angelbroking/user/v1/loginByPassword", "POST", { "X-PrivateKey": CONFIG.apiKey, "Content-Type": "application/json", Accept: "application/json", "X-SourceID": "WEB", "X-UserType": "USER", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00" }, { clientcode: CONFIG.clientId, password: mpin, totp });
      const jwt = login?.body?.data?.jwtToken; if (!jwt) return res.status(401).json({ ok: false, error: "Login failed", details: login?.body });
      SESSION.token = jwt; SESSION.feedToken = login?.body?.data?.feedToken || null; SESSION.updatedAt = Date.now();
      sendTg("✅ Login OK");
      // Resolve MCX immediately, then start WS
      resolveMcx().then(() => connectWS()).catch(() => connectWS());
      return res.json({ ok: true, token: jwt, wsEnabled: !!SESSION.feedToken });
    }
    if (action === "logout") { SESSION = { token: null, feedToken: null, updatedAt: 0 }; if (WS_CONN) try { WS_CONN.close(); } catch (e) {} WS_CONN = null; if (WS_TIMER) clearTimeout(WS_TIMER); return res.json({ ok: true }); }
    if (action === "fetch_all") {
      // Resolve MCX in background if not done
      if (!RESOLVED_MCX.picked.length) resolveMcx().catch(() => {});
      const mcxTokens = COM_TOKENS.length ? COM_TOKENS : ["257681", "254721", "258847", "259304"];
      const [indRaw, bseRaw, comRaw, stkRaw] = await Promise.all([
        fetchQuotes(token, "NSE", NSE_INDICES),
        fetchQuotes(token, "BSE", BSE_INDICES).catch(() => []),
        fetchQuotes(token, "MCX", mcxTokens).catch(() => []),
        fetchQuotes(token, "NSE", STOCKS)
      ]);
      const computeRiskOff = () => {
        const g = (GLOBAL_CACHE?.data || []);
        if (!g.length) return false;
        const neg = g.filter(x => (x.changePct || 0) < 0).length;
        return (neg / g.length) >= 0.6;
      };

      // Fetch global in background (non-blocking), use cache if available
      fetchGlobal().catch(() => {});
      const riskOff = computeRiskOff();

      const makeTimeRange2h = () => {
        const now = new Date();
        const to2 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const fr2 = new Date(now.getTime() - 2 * 3600000);
        const from2 = `${fr2.getFullYear()}-${String(fr2.getMonth() + 1).padStart(2, "0")}-${String(fr2.getDate()).padStart(2, "0")} ${String(fr2.getHours()).padStart(2, "0")}:${String(fr2.getMinutes()).padStart(2, "0")}`;
        return { from2, to2 };
      };

      const processInstrument = async (x, exch, ctx = {}) => {
        const d = buildMarketData(x, exch);
        try {
          const { from2, to2 } = makeTimeRange2h();
          const candles = await fetchCandles(token, exch, d.token, "FIVE_MINUTE", from2, to2);

          const closes = candles.map(c => c.c);
          const r = rsi(closes) ?? null;
          const mc = macd(closes) ?? null;
          const atrPack = calcATR(candles, 14);
          const regime = getRegime(candles);
          const pats = detectPatterns(candles);
          const aw = candles.length ? antiWhipsaw(candles) : { signal: "HOLD", reason: "No candles" };
          const ind = {
            emaFast: aw.emaFast, emaSlow: aw.emaSlow, vwap: aw.vwap,
            rsi: r, macdHist: mc?.histogram ?? 0,
            atrPack, atr: atrPack.atr, atrPct: atrPack.atrPct,
            regime, patterns: pats
          };

          // Score engine with macro context
          const se = scoreEngine(d, { ...ind, atrPack }, { ...ctx, riskOff, commodity: !!ctx.commodity, isIndex: !!ctx.isIndex });

          // Combine anti-whipsaw + score (anti-whipsaw can veto)
          let finalSig = (se.signal || "HOLD").toUpperCase();
          const awSig = (aw.signal || "HOLD").toUpperCase();
          if (awSig === "HOLD") {
            finalSig = "HOLD";
            se.reasonSimple = aw.reason || se.reasonSimple;
          } else {
            if (awSig === "BUY" && se.score < 60) { finalSig = "HOLD"; se.reasonSimple = "Wait — move not strong enough yet."; }
            else if (awSig === "SELL" && se.score > 40) { finalSig = "HOLD"; se.reasonSimple = "Wait — down move not strong enough yet."; }
            else finalSig = awSig;
          }

          const eng = {
            ...signalEngine(d, !!ctx.commodity), // legacy fields
            ...se,
            signal: finalSig,
            reason: aw.reason || "",
            reasonSimple: se.reasonSimple || "",
            vwap: aw.vwap, emaFast: aw.emaFast, emaSlow: aw.emaSlow,
            regime, patterns: pats,
            rsi: r, macd: mc,
            atr: atrPack.atr, atrPct: atrPack.atrPct
          };

          const out = { ...d, engine: enrichEngine(d, eng) };
          // Attach lightweight internal fields for alert construction (safe to include)
          out._levels = computeLevelsFromCandles(candles, 12);
          out._indicators = { score: out.engine.score, atr: out.engine.atr, atrPct: out.engine.atrPct, emaFast: out.engine.emaFast, emaSlow: out.engine.emaSlow, vwap: out.engine.vwap, rsi: out.engine.rsi, macdHist: out.engine.macd?.histogram ?? 0, regime: out.engine.regime };
          return out;
        } catch (e) {
          const eng = enrichEngine(d, signalEngine(d, !!ctx.commodity));
          return { ...d, engine: eng };
        }
      };
const nseIdx = await Promise.all(indRaw.map(x => processInstrument(x, "NSE", { isIndex: true })));
      const bseIdx = await Promise.all((bseRaw || []).map(x => processInstrument(x, "BSE", { isIndex: true })));
      const indices = [...nseIdx, ...bseIdx];
      const commodities = await Promise.all((comRaw || []).map(x => processInstrument(x, "MCX", { commodity: true })));
      const stocks = await Promise.all((stkRaw || []).map(x => processInstrument(x, "NSE", { commodity: false })));
      const ctxByKey = {};
      [...indices, ...stocks, ...commodities].forEach(it => {
        const k = `${it.exchange}:${it.token}`;
        ctxByKey[k] = { isIndex: NSE_INDICES.includes(String(it.token||"")), commodity: String(it.exchange).toUpperCase()==="MCX" };
      });
      const alerts = buildSmartAlerts([].concat(indices||[], stocks||[], commodities||[]), ctxByKey);
      
      const watchlist = buildNextDayWatchlist(indices, stocks);
      return res.json({ ok: true, data: { indices, commodities, stocks, watchlist, alerts, mcxResolved: RESOLVED_MCX?.picked?.map(p => p.label + "=" + p.symbol) || [] } });
    }
    res.json({ ok: false, error: "Invalid action" });
  } catch (e) { console.error("ERROR:", e); res.status(500).json({ ok: false, error: e.message }); }
});

// ── STATIC ──
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_, res) => { const p = path.join(__dirname, "public", "index.html"); if (fs.existsSync(p)) return res.sendFile(p); res.send("Trade Genie PRO v3.1"); });
app.get(["/dashboard", "/trade", "/stocks", "/commodities", "/news", "/global"], (_, res) => { const p = path.join(__dirname, "public", "index.html"); if (fs.existsSync(p)) return res.sendFile(p); res.redirect("/"); });

app.listen(PORT, () => console.log(`🚀 Trade Genie PRO v3.1 on port ${PORT}`));
