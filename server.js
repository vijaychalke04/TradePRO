// =============================================
// TRADE GENIE PRO - PRODUCTION SERVER v2.1
// Render Free Tier Optimized
// =============================================

const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =============================================
// CONFIG
// =============================================
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "JkFNQiMO",
  clientId: process.env.ANGEL_CLIENT_ID || "V58776779",
  baseURL: "apiconnect.angelone.in"
};

// =============================================
// TELEGRAM ALERTS (optional, best-effort)
// =============================================
const TELEGRAM = {
  token: process.env.TELEGRAM_TOKEN || "",
  chatId: process.env.TELEGRAM_CHAT_ID || ""
};

function sendTelegramAlert(message) {
  try {
    if (!TELEGRAM.token || !TELEGRAM.chatId) return;
    const payload = JSON.stringify({
      chat_id: TELEGRAM.chatId,
      text: `🧞 GENIE ALERT\n\n${message}`,
      parse_mode: "Markdown"
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TELEGRAM.token}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      },
      res => { res.on("data", () => {}); res.on("end", () => {}); }
    );
    req.on("error", () => {});
    req.write(payload);
    req.end();
  } catch (e) { /* ignore */ }
}

// =============================================
// GREEKS (Black-Scholes, dependency-free)
// =============================================
const Greeks = {
  _pdf: (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI),
  _cdf: (x) => {
    const a1 = 0.3193815, a2 = -0.3565638, a3 = 1.781478, a4 = -1.821256, a5 = 1.330274;
    const L = Math.abs(x);
    const k = 1 / (1 + 0.2316419 * L);
    const w = 1 - Greeks._pdf(L) * (a1 * k + a2 * k * k + a3 * k * k * k + a4 * k * k * k * k + a5 * k * k * k * k * k);
    return x < 0 ? 1 - w : w;
  },
  compute: ({ S, K, T, r = 0.07, sigma = 0.2, type = "CE" }) => {
    S = Number(S); K = Number(K); T = Number(T); r = Number(r); sigma = Number(sigma);
    if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return { ok: false, error: "Invalid inputs" };
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const Nd1 = Greeks._cdf(d1), Nd2 = Greeks._cdf(d2), nd1 = Greeks._pdf(d1);
    const isCall = String(type || "CE").toUpperCase().includes("C");
    const delta = isCall ? Nd1 : (Nd1 - 1);
    const gamma = nd1 / (S * sigma * sqrtT);
    const vega = (S * nd1 * sqrtT) / 100;
    const theta = (-(S * nd1 * sigma) / (2 * sqrtT) - (isCall ? r * K * Math.exp(-r * T) * Nd2 : -r * K * Math.exp(-r * T) * Greeks._cdf(-d2))) / 365;
    return { ok: true, inputs: { S, K, T, r, sigma, type: isCall ? "CE" : "PE" }, d1: +d1.toFixed(4), d2: +d2.toFixed(4), delta: +delta.toFixed(4), gamma: +gamma.toFixed(6), vega: +vega.toFixed(4), theta: +theta.toFixed(4) };
  }
};

// =============================================
// INSTRUMENTS - EXPANDED
// =============================================
const COM_TOKENS = ["257681", "254721", "258847", "259304"];
const COM_CONTRACTS = [
  { label: "GOLDM", keywords: ["GOLDM", "GOLD MINI", "GOLD-M"] },
  { label: "GOLD", keywords: ["GOLD"] },
  { label: "SILVERM", keywords: ["SILVERM", "SILVER MINI", "SILVER-M"] },
  { label: "SILVER", keywords: ["SILVER"] },
  { label: "CRUDEOIL", keywords: ["CRUDEOIL", "CRUDE OIL", "CRUDE"] },
  { label: "NATGAS", keywords: ["NATGAS", "NATURALGAS", "NATURAL GAS"] }
];
let RESOLVED_MCX = { updatedAt: 0, picked: [] };

// Expanded: Nifty50, BankNifty, FinNifty, India VIX, NiftyNext50, MidcapNifty
const NSE_INDICES = ["99926000", "99926009", "99926037", "99926017", "99926013", "99926074"];
const BSE_INDICES = ["99919000", "99919016"];
const COMMODITIES = ["257681", "254721", "258847", "259304"];
const STOCKS = ["3045", "11536", "1333", "1594", "4963", "1660", "3787"];

// =============================================
// DATA DIR + CACHES
// =============================================
const DATA_DIR = path.join(__dirname, "data");
const SCRIP_CACHE_PATH = path.join(DATA_DIR, "scripMaster.json");
const QUOTE_CACHE_PATH = path.join(DATA_DIR, "lastQuotes.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let SCRIP_MASTER = { updatedAt: 0, rows: [] };
let QUOTE_CACHE = { updatedAt: 0, byToken: {} };
try {
  if (fs.existsSync(QUOTE_CACHE_PATH)) {
    QUOTE_CACHE = JSON.parse(fs.readFileSync(QUOTE_CACHE_PATH, "utf8"));
    if (!QUOTE_CACHE || typeof QUOTE_CACHE !== "object") QUOTE_CACHE = { updatedAt: 0, byToken: {} };
    if (!QUOTE_CACHE.byToken) QUOTE_CACHE.byToken = {};
  }
} catch (e) { QUOTE_CACHE = { updatedAt: 0, byToken: {} }; }

let SESSION = { token: null, updatedAt: 0 };

// =============================================
// REQUEST HELPER
// =============================================
function requestAngel(reqPath, method, headers, data) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: CONFIG.baseURL, path: reqPath, method, headers }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = { parseError: e.message, raw: body || "" }; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function getHeaders(token) {
  return { Authorization: `Bearer ${token}`, "X-PrivateKey": CONFIG.apiKey, "Content-Type": "application/json", "Accept": "application/json", "X-SourceID": "WEB", "X-UserType": "USER", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00" };
}

// =============================================
// QUOTE CACHE
// =============================================
function cacheQuotes(fetchedList, exchange) {
  const now = Date.now();
  QUOTE_CACHE.updatedAt = now;
  if (!QUOTE_CACHE.byToken) QUOTE_CACHE.byToken = {};
  for (const item of (fetchedList || [])) {
    const token = String(item?.symbolToken || item?.token || item?.symboltoken || "");
    if (!token) continue;
    const ltp = Number(item?.ltp ?? item?.lastTradedPrice ?? item?.netPrice ?? item?.last_price ?? item?.close ?? 0);
    QUOTE_CACHE.byToken[token] = { exchange, name: item?.tradingSymbol || item?.tradingsymbol || item?.symbol || null, ltp: Number.isFinite(ltp) ? ltp : null, raw: item, ts: now };
  }
  try { fs.writeFileSync(QUOTE_CACHE_PATH, JSON.stringify(QUOTE_CACHE, null, 2)); } catch (e) {}
}
function getCachedToken(token) { return QUOTE_CACHE?.byToken?.[String(token)] || null; }

// =============================================
// SCRIP MASTER
// =============================================
async function fetchScripMaster(force = false) {
  const now = Date.now();
  const maxAgeMs = 6 * 60 * 60 * 1000;
  const stale = !SCRIP_MASTER.updatedAt || (now - SCRIP_MASTER.updatedAt > maxAgeMs);
  if (!force && !stale && Array.isArray(SCRIP_MASTER.rows) && SCRIP_MASTER.rows.length) return SCRIP_MASTER;
  try {
    if (fs.existsSync(SCRIP_CACHE_PATH)) {
      const disk = JSON.parse(fs.readFileSync(SCRIP_CACHE_PATH, "utf8"));
      if (disk?.updatedAt && Array.isArray(disk.rows) && disk.rows.length && !force && (now - disk.updatedAt <= maxAgeMs)) { SCRIP_MASTER = disk; return SCRIP_MASTER; }
    }
  } catch (e) {}
  const url = new URL("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json");
  const raw = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: "GET", timeout: 20000 }, res => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data); reject(new Error("ScripMaster HTTP " + res.statusCode)); });
    });
    req.on("timeout", () => req.destroy(new Error("ScripMaster timeout")));
    req.on("error", reject); req.end();
  });
  let rows = [];
  try { rows = JSON.parse(raw); if (!Array.isArray(rows)) rows = []; } catch (e) { rows = []; }
  SCRIP_MASTER = { updatedAt: now, rows };
  try { fs.writeFileSync(SCRIP_CACHE_PATH, JSON.stringify(SCRIP_MASTER, null, 2)); } catch (e) {}
  return SCRIP_MASTER;
}

function getSymbolToken(symbol, exch = "NSE") {
  if (!symbol) return null;
  const sym = String(symbol).trim().toUpperCase(), seg = String(exch).trim().toUpperCase();
  const hit = (SCRIP_MASTER.rows || []).find(r => String(r.symbol || r.tradingsymbol || "").toUpperCase() === sym && String(r.exch_seg || r.exchange || "").toUpperCase() === seg);
  return hit ? { token: String(hit.token || ""), row: hit } : null;
}

function searchScrip(q, exch = "", limit = 20) {
  const query = String(q || "").trim().toUpperCase(), seg = String(exch || "").trim().toUpperCase();
  const lim = Math.min(Math.max(parseInt(limit || 20, 10) || 20, 1), 50);
  if (query.length < 2) return [];
  const out = [];
  for (const r of (SCRIP_MASTER.rows || [])) {
    const rSym = String(r.symbol || r.tradingsymbol || "").toUpperCase();
    if (!rSym) continue;
    if (seg && String(r.exch_seg || r.exchange || "").toUpperCase() !== seg) continue;
    if (rSym.includes(query)) {
      out.push({ symbol: r.symbol || r.tradingsymbol || null, token: String(r.token || ""), exch: r.exch_seg || r.exchange || null, name: r.name || r.symbolname || null, instrumenttype: r.instrumenttype || null, lotsize: r.lotsize || null, expiry: r.expiry || null, strike: r.strike || null });
      if (out.length >= lim) break;
    }
  }
  return out;
}

// =============================================
// MCX TOKEN RESOLVER
// =============================================
async function resolveMcxTokens() {
  try {
    await fetchScripMaster(false);
    const today = new Date(), startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const parseExpiry = (e) => { try { e = String(e || "").trim(); if (!e) return null; if (e.includes("-")) { const d = new Date(e); return isNaN(d) ? null : d; } const dd = e.slice(0, 2), mmm = e.slice(2, 5).toUpperCase(), yy = e.slice(5); const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }; const d = new Date(Number(yy), months[mmm] ?? 0, Number(dd)); return isNaN(d) ? null : d; } catch { return null; } };
    const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, "").replace(/-/g, "");
    const pickNearestFut = (keywords) => {
      const kws = (keywords || []).map(norm).filter(Boolean);
      const rows = (SCRIP_MASTER.rows || []).filter(r => { const seg = String(r.exch_seg || r.exchange || "").toUpperCase(); if (seg !== "MCX") return false; const sym = norm(r.symbol || r.tradingsymbol || ""); if (!sym) return false; const it = String(r.instrumenttype || r.instrument_type || "").toUpperCase(); if (it && !(it.includes("FUT") || it.includes("FUTCOM"))) return false; return kws.some(kw => sym.includes(kw)); });
      const parsed = rows.map(r => ({ r, exp: parseExpiry(r.expiry) })).filter(x => x.exp instanceof Date && !isNaN(x.exp));
      if (!parsed.length) return null;
      const future = parsed.filter(x => x.exp >= startOfToday);
      return ((future.length ? future : parsed).sort((a, b) => a.exp - b.exp))[0]?.r || null;
    };
    const picked = [], seen = new Set();
    for (const c of COM_CONTRACTS) { const row = pickNearestFut(c.keywords); const token = row ? String(row.token || "") : ""; if (token && !seen.has(token)) { seen.add(token); picked.push({ label: c.label, token, symbol: row.symbol || row.tradingsymbol || null, expiry: row.expiry || null }); } }
    if (picked.length) { COM_TOKENS.length = 0; picked.forEach(x => COM_TOKENS.push(x.token)); RESOLVED_MCX = { updatedAt: Date.now(), picked }; }
  } catch (e) { /* ignore */ }
}

// =============================================
// DATA PROCESSING
// =============================================
function buildMarketData(item, exchange) {
  const ltp = parseFloat(item.ltp || 0), close = parseFloat(item.close || ltp), high = parseFloat(item.high || ltp), low = parseFloat(item.low || ltp), open = parseFloat(item.open || ltp);
  const change = ltp - close, changePct = close ? ((ltp - close) / close) * 100 : 0;
  return { name: item.tradingSymbol || "Unknown", token: item.symbolToken, exchange, ltp, open, high, low, close, change: +change.toFixed(2), changePct: +changePct.toFixed(2), range: +(high - low).toFixed(2) };
}

// =============================================
// SIGNAL ENGINES
// =============================================
function alphaEngine(i) { if (i.changePct > 0.6) return "BUY"; if (i.changePct < -0.6) return "SELL"; return "HOLD"; }
function betaEngine(i) { if (i.range === 0) return false; return Math.abs(i.changePct) > ((i.range / i.ltp) * 100 * 0.3); }
function riskEngine(i, commodity = false) { let risk = Math.abs(i.changePct) * 8 + (i.range / i.ltp) * 100 * 2; if (commodity) risk += 12; return Math.min(100, Math.round(risk)); }
function signalEngine(i, commodity = false) {
  const alpha = alphaEngine(i), beta = betaEngine(i), risk = riskEngine(i, commodity), mode = risk < 40 ? "MODE1" : "MODE2";
  if (alpha === "HOLD") return { signal: "HOLD", mode, risk };
  if (!beta) return { signal: "HOLD", mode, risk, warning: "Structure weak" };
  return { signal: alpha, mode, risk, warning: risk >= 40 ? "⚠️ Higher Risk" : "" };
}

const SIGNAL_BUFFER = { byToken: {}, confirmTicks: 2 };
function applyConfirmationBuffer(token, rawSignal) {
  const t = String(token || ""), s = String(rawSignal || "HOLD").toUpperCase();
  if (!t) return { signal: s, stabilizing: false };
  const st = SIGNAL_BUFFER.byToken[t] || { committed: "HOLD", pending: "HOLD", pendingCount: 0, lastTs: 0 };
  if (s === st.committed) { st.pending = s; st.pendingCount = 0; st.lastTs = Date.now(); SIGNAL_BUFFER.byToken[t] = st; return { signal: st.committed, stabilizing: false }; }
  if (s === st.pending) st.pendingCount++; else { st.pending = s; st.pendingCount = 1; }
  let stabilizing = true;
  if (st.pendingCount >= SIGNAL_BUFFER.confirmTicks) { st.committed = st.pending; st.pendingCount = 0; stabilizing = false; }
  st.lastTs = Date.now(); SIGNAL_BUFFER.byToken[t] = st;
  return { signal: st.committed, stabilizing };
}

function optionStrikeStep(ltp, isIndex) { if (isIndex) return 50; const p = Number(ltp || 0); if (p <= 0) return 50; if (p < 200) return 5; if (p < 500) return 10; if (p < 1000) return 20; if (p < 2000) return 50; return 100; }
function roundToStep(x, step) { return Math.round(x / step) * step; }
function suggestOption(name, ltp, direction, isIndex) {
  const step = optionStrikeStep(ltp, isIndex), price = Number(ltp || 0), dir = String(direction || "HOLD").toUpperCase();
  if (!(price > 0) || (dir !== "BUY" && dir !== "SELL")) return null;
  const optType = dir === "BUY" ? "CE" : "PE"; let strike = roundToStep(price, step);
  if (optType === "CE" && strike < price) strike += step; if (optType === "PE" && strike > price) strike -= step;
  return { optionType: optType, strike, step, suggested: `${String(name || "").replace(/-EQ$/i, "").trim()} ${strike} ${optType}`, basis: isIndex ? "INDEX" : "STOCK" };
}

function enrichEngine(market, engine) {
  const ltp = Number(market?.ltp || 0), mode = engine?.mode || "MODE1";
  const buf = applyConfirmationBuffer(market?.token, engine?.signal || "HOLD");
  const signal = buf.signal;
  const tgtPct = mode === "MODE2" ? 0.020 : 0.010, slPct = mode === "MODE2" ? 0.010 : 0.005;
  let trade = "WAIT", projectedTarget = null, stopLoss = null, targetLow = null, targetHigh = null, optionSuggestion = null;
  const tknStr = String(market?.token || ""), nm = String(market?.name || "").toUpperCase(), ex = String(market?.exchange || "").toUpperCase();
  const isIndex = (ex === "NSE" && NSE_INDICES.includes(tknStr) && (nm.includes("NIFTY") || nm.includes("VIX")));
  if (signal === "BUY") { trade = isIndex ? "BUY CE (Index)" : `BUY ${market.name}`; projectedTarget = ltp ? +(ltp * (1 + tgtPct)).toFixed(2) : null; stopLoss = ltp ? +(ltp * (1 - slPct)).toFixed(2) : null; targetLow = ltp ? +(ltp * (1 + tgtPct * 0.8)).toFixed(2) : null; targetHigh = ltp ? +(ltp * (1 + tgtPct * 1.6)).toFixed(2) : null; optionSuggestion = suggestOption(market?.name, ltp, "BUY", isIndex); }
  else if (signal === "SELL") { trade = isIndex ? "BUY PE (Index)" : `SELL ${market.name}`; projectedTarget = ltp ? +(ltp * (1 - tgtPct)).toFixed(2) : null; stopLoss = ltp ? +(ltp * (1 + slPct)).toFixed(2) : null; targetLow = ltp ? +(ltp * (1 - tgtPct * 1.6)).toFixed(2) : null; targetHigh = ltp ? +(ltp * (1 - tgtPct * 0.8)).toFixed(2) : null; optionSuggestion = suggestOption(market?.name, ltp, "SELL", isIndex); }
  return { ...engine, signal, stabilizing: buf.stabilizing, trade, projectedTarget, targetLow, targetHigh, stopLoss, optionSuggestion, reason: engine?.reason || engine?.warning || "" };
}

// =============================================
// FETCH QUOTES / CANDLE DATA
// =============================================
async function fetchQuotes(token, exchange, tokens) {
  const res = await requestAngel("/rest/secure/angelbroking/market/v1/quote/", "POST", getHeaders(token), { mode: "FULL", exchangeTokens: { [exchange]: tokens } });
  const fetched = res?.body?.data?.fetched || [];
  if (Array.isArray(fetched) && fetched.length) cacheQuotes(fetched, exchange);
  return fetched;
}

async function fetchCandleData(token, exchange, symbolToken, interval, fromdate, todate) {
  const raw = await requestAngel("/rest/secure/angelbroking/historical/v1/getCandleData", "POST", getHeaders(token), { exchange, symboltoken: String(symbolToken), interval, fromdate, todate });
  const data = raw?.body?.data;
  if (!Array.isArray(data)) return [];
  return data.map(c => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
}

// =============================================
// TECHNICAL INDICATORS
// =============================================
function ema(values, period) { if (!Array.isArray(values) || values.length < period) return null; const k = 2 / (period + 1); let e = values[0]; for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k); return e; }

function emaArray(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1), out = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < values.length; i++) { if (i < period - 1) { out.push(null); continue; } if (i === period - 1) { out.push(e); continue; } e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses += Math.abs(d); }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period; avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period; }
  if (avgLoss === 0) return 100;
  return +(100 - (100 / (1 + avgGain / avgLoss))).toFixed(2);
}

function vwap(candles) { let pv = 0, vol = 0; for (const x of candles) { const tp = (x.h + x.l + x.c) / 3; pv += tp * (x.v || 0); vol += (x.v || 0); } return vol > 0 ? (pv / vol) : null; }

function getMarketRegime(candles) {
  if (!Array.isArray(candles) || candles.length < 25) return "COLLECTING";
  const closes = candles.map(x => x.c);
  const e5 = ema(closes.slice(-20), 5), e20 = ema(closes, 20);
  if (e5 == null || e20 == null) return "COLLECTING";
  let trs = []; for (let i = 1; i < candles.length; i++) { const pc = candles[i - 1].c; trs.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc))); }
  const last14 = trs.slice(-14), atr = last14.reduce((a, b) => a + b, 0) / Math.max(1, last14.length);
  const atrPct = (atr / closes[closes.length - 1]) * 100, slope = (e5 - e20) / e20 * 100;
  return (Math.abs(slope) > 0.08 && atrPct > 0.15) ? "TRENDING" : "SIDEWAYS";
}

function antiWhipsawIndexSignal(candles, fast = 9, slow = 21) {
  if (!Array.isArray(candles) || candles.length < Math.max(slow + 5, 30)) return { signal: "HOLD", reason: "Not enough candles" };
  const closes = candles.map(x => x.c), ef = ema(closes, fast), es = ema(closes, slow), vw = vwap(candles);
  if (ef == null || es == null || vw == null) return { signal: "HOLD", reason: "Indicator not ready" };
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  if (Math.abs(last.c - vw) / vw < 0.0005) return { signal: "HOLD", reason: "Too close to VWAP", emaFast: ef, emaSlow: es, vwap: vw };
  if (ef > es && last.c > vw && prev.c > vw && last.c > es) return { signal: "BUY", reason: "VWAP+EMA aligned UP", emaFast: ef, emaSlow: es, vwap: vw };
  if (ef < es && last.c < vw && prev.c < vw && last.c < es) return { signal: "SELL", reason: "VWAP+EMA aligned DOWN", emaFast: ef, emaSlow: es, vwap: vw };
  return { signal: "HOLD", reason: "No alignment", emaFast: ef, emaSlow: es, vwap: vw };
}

// =============================================
// MONTE CARLO
// =============================================
const MC_CACHE = {}, MC_TTL_MS = 5 * 60 * 1000;
function mcKey(o) { return `${o.exchange}:${o.token}:${o.interval}:${o.days}:${o.paths}`; }
function computeMCFromCloses(closes, days, paths) {
  const rets = []; for (let i = 1; i < closes.length; i++) { const r = Math.log(closes[i] / closes[i - 1]); if (Number.isFinite(r)) rets.push(r); }
  if (rets.length < 20) return { ok: false, error: "Not enough returns" };
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, rets.length - 1));
  const S0 = closes[closes.length - 1], nSteps = Math.max(5, parseInt(days) || 20), nPaths = Math.min(3000, Math.max(300, parseInt(paths) || 1000));
  let winsUp = 0, winsDn = 0, finals = [];
  for (let p = 0; p < nPaths; p++) { let S = S0; for (let k = 0; k < nSteps; k++) { const u1 = Math.random() || 1e-9, u2 = Math.random() || 1e-9; S = S * Math.exp((mu - 0.5 * sd * sd) + sd * (Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2))); } finals.push(S); if (S >= S0 * 1.005) winsUp++; if (S <= S0 * 0.995) winsDn++; }
  finals.sort((a, b) => a - b);
  const pct = (q) => finals[Math.floor(q * (finals.length - 1))] || finals[0];
  return { ok: true, S0, mu, sigma: sd, params: { days: nSteps, paths: nPaths }, stats: { winUp0_5: +(winsUp / nPaths * 100).toFixed(2), winDown0_5: +(winsDn / nPaths * 100).toFixed(2), p10: +pct(0.10).toFixed(2), p50: +pct(0.50).toFixed(2), p90: +pct(0.90).toFixed(2), mu: +mu.toFixed(6), sigma: +sd.toFixed(6) } };
}

async function getMonteCarloCached(jwtToken, exchange, token, interval = "FIFTEEN_MINUTE", days = 20, paths = 1000) {
  const key = mcKey({ exchange, token, interval, days, paths }), now = Date.now(), hit = MC_CACHE[key];
  if (hit && (now - hit.ts) < MC_TTL_MS) return hit.payload;
  const nowD = new Date();
  const todate = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, "0")}-${String(nowD.getDate()).padStart(2, "0")} ${String(nowD.getHours()).padStart(2, "0")}:${String(nowD.getMinutes()).padStart(2, "0")}`;
  const from = new Date(nowD.getTime() - 14 * 24 * 60 * 60 * 1000);
  const fromdate = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")} 09:15`;
  const candles = await fetchCandleData(jwtToken, exchange, token, interval, fromdate, todate);
  const closes = candles.map(c => c.c).filter(x => Number.isFinite(x));
  if (closes.length < 30) return null;
  const out = computeMCFromCloses(closes, days, paths);
  if (!out.ok) return null;
  const payload = { exchange, token, interval, S0: out.S0, params: out.params, stats: out.stats };
  MC_CACHE[key] = { ts: now, payload }; return payload;
}
function classifyEdge(winProb) { if (winProb == null) return { badge: "NA", color: "gray" }; if (winProb >= 60) return { badge: "POSITIVE", color: "green" }; if (winProb >= 50) return { badge: "NEUTRAL", color: "amber" }; return { badge: "NEGATIVE", color: "red" }; }

// =============================================
// REAL EMA BACKTEST ENGINE
// =============================================
const BT_CACHE = {}, BT_TTL_MS = 3 * 60 * 1000;

function runEmaBacktest(candles, fastP = 9, slowP = 21) {
  if (!Array.isArray(candles) || candles.length < slowP + 10) return { ok: false, error: "Not enough candle data" };
  const closes = candles.map(c => c.c), fastEma = emaArray(closes, fastP), slowEma = emaArray(closes, slowP);
  const trades = []; let position = null;
  for (let i = slowP + 1; i < closes.length; i++) {
    const fP = fastEma[i - 1], sP = slowEma[i - 1], fC = fastEma[i], sC = slowEma[i];
    if (fP == null || sP == null || fC == null || sC == null) continue;
    if (fP <= sP && fC > sC) { if (position && position.type === "SELL") { trades.push({ type: "SELL", entry: position.entry, exit: closes[i], pnl: position.entry - closes[i] }); position = null; } if (!position) position = { type: "BUY", entry: closes[i] }; }
    if (fP >= sP && fC < sC) { if (position && position.type === "BUY") { trades.push({ type: "BUY", entry: position.entry, exit: closes[i], pnl: closes[i] - position.entry }); position = null; } if (!position) position = { type: "SELL", entry: closes[i] }; }
  }
  const lastClose = closes[closes.length - 1];
  if (position) { trades.push({ type: position.type, entry: position.entry, exit: lastClose, pnl: position.type === "BUY" ? lastClose - position.entry : position.entry - lastClose, open: true }); }
  if (!trades.length) return { ok: true, totalTrades: 0, winRate: 0, signal: "HOLD", message: "No crossover signals in period" };
  const wins = trades.filter(t => t.pnl > 0).length, winRate = +(wins / trades.length * 100).toFixed(1);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0), avgPnl = +(totalPnl / trades.length).toFixed(2);
  const lastFast = fastEma[fastEma.length - 1], lastSlow = slowEma[slowEma.length - 1], rsiVal = rsi(closes, 14);
  let currentSignal = "HOLD"; if (lastFast > lastSlow) currentSignal = "BUY"; else if (lastFast < lastSlow) currentSignal = "SELL";
  let confidence = "MEDIUM";
  if (currentSignal === "BUY" && rsiVal > 50 && rsiVal < 70) confidence = "HIGH";
  else if (currentSignal === "SELL" && rsiVal < 50 && rsiVal > 30) confidence = "HIGH";
  else if ((currentSignal === "BUY" && rsiVal > 70) || (currentSignal === "SELL" && rsiVal < 30)) confidence = "OVERBOUGHT/OVERSOLD";
  return { ok: true, ltp: lastClose, strategy: `EMA(${fastP}/${slowP}) Crossover`, totalTrades: trades.length, wins, losses: trades.length - wins, winRate, avgPnl, totalPnl: +totalPnl.toFixed(2), signal: currentSignal, confidence, rsi: rsiVal, emaFast: +(lastFast).toFixed(2), emaSlow: +(lastSlow).toFixed(2), lastTrades: trades.slice(-5).map(t => ({ ...t, pnl: +t.pnl.toFixed(2) })) };
}

// =============================================
// ROUTES
// =============================================
app.get("/api/health", (req, res) => res.json({ success: true, service: "Trade Genie PRO v2.1", time: new Date().toISOString() }));
app.get("/api/status", (req, res) => res.json({ success: true, service: "Trade Genie", version: "2.1", time: new Date().toISOString(), loggedIn: !!SESSION?.token, mcxResolved: RESOLVED_MCX || null }));
app.get("/api/session/status", (req, res) => res.json({ success: true, loggedIn: !!SESSION.token, updatedAt: SESSION.updatedAt || null }));

app.get("/api/scrip/find", async (req, res) => { try { const symbol = String(req.query.symbol || "").trim(), exch = String(req.query.exch || "NSE").trim().toUpperCase(); if (!symbol) return res.status(400).json({ success: false, error: "symbol required" }); await fetchScripMaster(false); const hit = getSymbolToken(symbol, exch); if (!hit) return res.json({ success: true, found: false }); return res.json({ success: true, found: true, token: hit.token, meta: hit.row }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.get("/api/scrip/search", async (req, res) => { try { await fetchScripMaster(false); return res.json({ success: true, results: searchScrip(req.query.q, req.query.exch, req.query.limit) }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.get("/api/mcx/resolved", (req, res) => res.json({ success: true, resolved: RESOLVED_MCX }));

app.get("/api/mcx/ltp", async (req, res) => {
  try {
    const jwtToken = (req.query && req.query.token) || (req.headers.authorization ? String(req.headers.authorization).replace(/^Bearer\s+/i, "") : "") || SESSION?.token || null;
    if (!jwtToken) return res.status(401).json({ success: false, error: "Not logged in" });
    const picked = RESOLVED_MCX?.picked || [];
    if (!picked.length) return res.json({ success: true, source: "none", data: [] });
    const mcxQuotes = await fetchQuotes(jwtToken, "MCX", picked.map(p => ({ token: p.token })));
    const map = new Map((mcxQuotes || []).map(q => [String(q.token), q]));
    const out = picked.map(p => { const q = map.get(String(p.token)); const ltp = q ? (q.ltp ?? q.last_price ?? null) : null; return { label: p.label, token: p.token, symbol: p.symbol, expiry: p.expiry, ltp: ltp != null ? Number(ltp) : null }; });
    res.json({ success: true, source: "live", data: out });
  } catch (e) { res.status(500).json({ success: false, error: String(e?.message || e) }); }
});

app.post("/api/options/greeks", (req, res) => { try { const { S, K, T_days, r, sigma, type } = req.body || {}; const out = Greeks.compute({ S, K, T: Number(T_days) / 365, r, sigma, type }); if (!out.ok) return res.status(400).json({ success: false, error: out.error }); res.json({ success: true, greeks: out }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });

// Real backtest
app.post("/api/backtest/stock", async (req, res) => {
  try {
    const { symbol, exchange = "NSE", jwtToken, fast = 9, slow = 21 } = req.body || {};
    const sym = String(symbol || "").trim().toUpperCase();
    if (!sym) return res.status(400).json({ success: false, error: "symbol required" });
    const jwt = jwtToken || SESSION?.token;
    if (!jwt) return res.status(401).json({ success: false, error: "Not logged in" });
    const cacheKey = `${exchange}:${sym}:${fast}:${slow}`;
    const cached = BT_CACHE[cacheKey];
    if (cached && (Date.now() - cached.ts) < BT_TTL_MS) return res.json({ success: true, cached: true, ...cached.data });
    await fetchScripMaster(false);
    const hit = getSymbolToken(sym + "-EQ", exchange) || getSymbolToken(sym, exchange);
    if (!hit) return res.json({ success: false, error: `Symbol ${sym} not found` });
    const now = new Date();
    const todate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} 15:30`;
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromdate = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")} 09:15`;
    const candles = await fetchCandleData(jwt, exchange, hit.token, "FIFTEEN_MINUTE", fromdate, todate);
    if (!candles.length) return res.json({ success: false, error: "No candle data for " + sym });
    const result = runEmaBacktest(candles, fast, slow);
    if (!result.ok) return res.json({ success: false, error: result.error || result.message });
    const data = { symbol: sym, exchange, token: hit.token, candleCount: candles.length, ...result };
    BT_CACHE[cacheKey] = { ts: Date.now(), data };
    return res.json({ success: true, ...data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/backtest/montecarlo", async (req, res) => {
  try {
    const { token: symbolToken, exchange = "NSE", jwtToken, days = 20, paths = 1000, interval = "FIFTEEN_MINUTE" } = req.body || {};
    const t = String(symbolToken || "").trim();
    if (!t) return res.status(400).json({ success: false, error: "token required" });
    const jwt = jwtToken || SESSION?.token;
    if (!jwt) return res.status(400).json({ success: false, error: "jwtToken required" });
    const now = new Date();
    const todate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const from = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const fromdate = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")} 09:15`;
    const candles = await fetchCandleData(jwt, exchange, t, interval, fromdate, todate);
    if (!candles.length) return res.json({ success: false, error: "No candle data" });
    const closes = candles.map(c => c.c).filter(x => Number.isFinite(x));
    if (closes.length < 30) return res.json({ success: false, error: "Not enough closes" });
    const out = computeMCFromCloses(closes, days, paths);
    if (!out.ok) return res.json({ success: false, error: out.error });
    return res.json({ success: true, exchange, token: t, interval, S0: out.S0, params: out.params, stats: out.stats });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Main angel route
app.post("/api/angel", async (req, res) => {
  const { action, mpin, totp, token } = req.body;
  try {
    if (action === "login") {
      const login = await requestAngel("/rest/auth/angelbroking/user/v1/loginByPassword", "POST", { "X-PrivateKey": CONFIG.apiKey, "Content-Type": "application/json", "Accept": "application/json", "X-SourceID": "WEB", "X-UserType": "USER", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00" }, { clientcode: CONFIG.clientId, password: mpin, totp });
      const jwt = login?.body?.data?.jwtToken;
      if (!jwt) return res.status(401).json({ success: false, error: "Angel login failed", httpStatus: login?.statusCode, details: login?.body });
      SESSION.token = jwt; SESSION.updatedAt = Date.now();
      sendTelegramAlert(`✅ Login OK\nClient: ${CONFIG.clientId}`);
      return res.json({ success: true, token: jwt });
    }
    if (action === "logout") { SESSION.token = null; SESSION.updatedAt = 0; return res.json({ success: true, message: "Logged out" }); }
    if (action === "fetch_all") {
      resolveMcxTokens().catch(() => {});
      const [indRaw, bseRaw, comRaw, stkRaw] = await Promise.all([
        fetchQuotes(token, "NSE", NSE_INDICES),
        fetchQuotes(token, "BSE", BSE_INDICES).catch(() => []),
        fetchQuotes(token, "MCX", COMMODITIES),
        fetchQuotes(token, "NSE", STOCKS)
      ]);
      const processIndex = async (x, exch) => {
        const d = buildMarketData(x, exch);
        try {
          const now = new Date();
          const todate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
          const fromdate = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")} ${String(from.getHours()).padStart(2, "0")}:${String(from.getMinutes()).padStart(2, "0")}`;
          const candles = await fetchCandleData(token, exch, d.token, "FIVE_MINUTE", fromdate, todate);
          const sig = candles.length ? antiWhipsawIndexSignal(candles) : { signal: "HOLD", reason: "No candles" };
          const regime = getMarketRegime(candles);
          const mc = await getMonteCarloCached(token, exch, d.token, "FIFTEEN_MINUTE", 20, 1000);
          const edge = classifyEdge(mc?.stats?.winUp0_5);
          const engine = { ...signalEngine(d, false), signal: sig.signal, mode: sig.signal === "BUY" ? "MODE1" : sig.signal === "SELL" ? "MODE2" : "MODE1", reason: sig.reason, vwap: sig.vwap ?? null, emaFast: sig.emaFast ?? null, emaSlow: sig.emaSlow ?? null, regime, mc, edge: edge.badge };
          if (engine.signal === "BUY" && ((mc?.stats?.winUp0_5 ?? 0) < 50 || ((mc?.stats?.winUp0_5 ?? 0) < 60 && regime !== "TRENDING"))) engine.signal = "HOLD";
          if (engine.signal === "SELL" && ((mc?.stats?.winDown0_5 ?? 0) < 50 || ((mc?.stats?.winDown0_5 ?? 0) < 60 && regime !== "TRENDING"))) engine.signal = "HOLD";
          if (mc?.stats) { engine.expected = { p10: mc.stats.p10, p50: mc.stats.p50, p90: mc.stats.p90 }; if (engine.signal === "BUY") { engine.projectedTarget = `${mc.stats.p50} - ${mc.stats.p90}`; engine.stopLoss = mc.stats.p10; } else if (engine.signal === "SELL") { engine.projectedTarget = `${mc.stats.p50} - ${mc.stats.p10}`; engine.stopLoss = mc.stats.p90; } else { engine.projectedTarget = mc.stats.p50; engine.stopLoss = mc.stats.p10; } }
          return { ...d, engine: enrichEngine(d, engine) };
        } catch (e) { return { ...d, engine: enrichEngine(d, signalEngine(d, false)), candleError: e.message }; }
      };
      const nseIdx = await Promise.all(indRaw.map(x => processIndex(x, "NSE")));
      const bseIdx = await Promise.all((bseRaw || []).map(x => processIndex(x, "BSE")));
      const indices = [...nseIdx, ...bseIdx];
      let commodities = (comRaw?.length ? comRaw : []).map(x => { const d = buildMarketData(x, "MCX"); return { ...d, engine: enrichEngine(d, signalEngine(d, true)) }; });
      if (!commodities.length) { const cached = COM_TOKENS.map(t => { const c = getCachedToken(t); if (!c) return null; return { name: c.name || ("MCX-" + t), token: t, exchange: "MCX", ltp: c.ltp, cached: true, engine: enrichEngine({ name: c.name, token: t, exchange: "MCX", ltp: c.ltp }, { signal: "HOLD", mode: "MODE1", warning: "CACHED" }) }; }).filter(Boolean); commodities = commodities.concat(cached); }
      const stocks = stkRaw.map(x => { const d = buildMarketData(x, "NSE"); return { ...d, engine: enrichEngine(d, signalEngine(d, false)) }; });
      return res.json({ success: true, data: { indices, commodities, stocks } });
    }
    res.json({ success: false, error: "Invalid action" });
  } catch (e) { console.error("ENGINE ERROR:", e); res.status(500).json({ success: false, error: e.message }); }
});

// Static + fallback
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => { const p = path.join(__dirname, "public", "index.html"); if (fs.existsSync(p)) return res.sendFile(p); res.send("Trade Genie PRO running"); });
app.get(["/dashboard", "/trade", "/stocks", "/commodities"], (req, res) => { const p = path.join(__dirname, "public", "index.html"); if (fs.existsSync(p)) return res.sendFile(p); res.redirect("/"); });
app.use((err, req, res, next) => { console.error("Unhandled:", err); res.status(500).json({ success: false, error: "Internal server error" }); });

app.listen(PORT, () => console.log(`🚀 Trade Genie PRO v2.1 on port ${PORT}`));
