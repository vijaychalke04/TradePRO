// =============================================
// TRADEPRO - STABLE ENGINE (KEEPING YOUR WORKING LOGIN)
// - Uses https.request (same as your working file)
// - Dynamic Scrip Master (no more hardcoded stock/MCX tokens)
// - Universal search + watchlist
// - Anti-whipsaw (3-cycle confirmation + cooldown)
// - VWAP + EMA confirmation (lightweight: only for focus symbols)
// =============================================

"use strict";

const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

// More defensive than process.env?.PORT
const PORT = (process && process.env && process.env.PORT) ? Number(process.env.PORT) : 3000;

// =============================================
// CONFIG (KEEP YOUR STYLE)
// =============================================
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "JkFNQiMO",
  clientId: process.env.ANGEL_CLIENT_ID || "V58776779",
  baseURL: "apiconnect.angelone.in"
};

// =============================================
// SCRIP MASTER (Dynamic Token Management)
// =============================================
const SCRIP_MASTER_URL_HOST = "margincalculator.angelbroking.com";
const SCRIP_MASTER_URL_PATH = "/OpenAPI_File/files/OpenAPIScripMaster.json";

let SCRIP_MASTER = [];
let SCRIP_READY = false;

// Watchlists are SYMBOL STRINGS (we resolve tokens dynamically)
let WATCHLIST_STOCKS = ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "ITC", "SBIN"];
let WATCHLIST_MCX = ["CRUDEOIL", "NATURALGAS", "GOLD", "SILVER"];

// Indices tokens are stable; keep them (Angel often has special index tokens)
// (These were already in your file) :contentReference[oaicite:2]{index=2}
const NSE_INDICES = ["99926000", "99926009", "99926017", "99926037"]; // NIFTY, BANKNIFTY, FINNIFTY, MIDCAP
const BSE_INDICES = ["99919000"]; // SENSEX (optional if you want)

function downloadJson(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error("Failed to parse scrip master JSON"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function loadScripMaster() {
  try {
    const data = await downloadJson(SCRIP_MASTER_URL_HOST, SCRIP_MASTER_URL_PATH);
    if (Array.isArray(data) && data.length > 1000) {
      SCRIP_MASTER = data;
      SCRIP_READY = true;
      console.log(`✅ Scrip Master loaded: ${SCRIP_MASTER.length}`);
    } else {
      console.log("⚠️ Scrip Master returned unexpected format/size");
    }
  } catch (e) {
    console.log("❌ Scrip Master load failed:", e.message);
  }
}

// Prefer nearest valid MCX contract when multiple matches exist
function parseExpiry(exp) {
  // Angel often uses "28FEB2026" or similar
  if (!exp || typeof exp !== "string") return null;
  const m = exp.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const monStr = m[2];
  const yyyy = Number(m[3]);
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const mm = months[monStr];
  if (mm === undefined) return null;
  return new Date(Date.UTC(yyyy, mm, dd)).getTime();
}

function bestMatchSymbol({ q, exch }) {
  if (!SCRIP_READY) return null;
  const Q = String(q || "").trim().toUpperCase();
  if (!Q) return null;

  const candidates = SCRIP_MASTER.filter((s) => {
    const sym = String(s.symbol || "").toUpperCase();
    const name = String(s.name || "").toUpperCase();
    const ex = String(s.exch_seg || "").toUpperCase();
    if (exch && ex !== exch.toUpperCase()) return false;
    return sym.includes(Q) || name.includes(Q);
  });

  if (!candidates.length) return null;

  // If MCX, pick nearest future expiry
  if ((exch || "").toUpperCase() === "MCX") {
    const now = Date.now();
    let best = null;
    let bestExpiry = Infinity;

    for (const c of candidates) {
      const exp = parseExpiry(String(c.expiry || ""));
      if (exp && exp >= now && exp < bestExpiry) {
        best = c;
        bestExpiry = exp;
      }
    }
    return best || candidates[0];
  }

  // NSE/BSE - prefer exact symbol startswith match
  const starts = candidates.find((c) => String(c.symbol || "").toUpperCase().startsWith(Q));
  return starts || candidates[0];
}

// =============================================
// ANGEL REQUEST HELPER (KEEP YOUR WORKING METHOD)
// =============================================
function requestAngel(path, method, headers, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CONFIG.baseURL,
        path,
        method,
        headers
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Invalid JSON response from Angel"));
          }
        });
      }
    );

    req.on("error", reject);

    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// Use the “richer headers” style (helps reliability). Your pro version had these fields. :contentReference[oaicite:3]{index=3}
function getHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "X-PrivateKey": CONFIG.apiKey,
    "Content-Type": "application/json",
    "X-SourceID": "WEB",
    "X-UserType": "USER",
    // These are commonly used; values are placeholders and typically accepted:
    "X-ClientLocalIP": "192.168.1.1",
    "X-ClientPublicIP": "106.193.147.98",
    "X-MACAddress": "00:00:00:00:00:00"
  };
}

// =============================================
// QUOTES + CANDLES
// =============================================
async function fetchQuotes(jwt, exchange, tokenList) {
  const res = await requestAngel(
    "/rest/secure/angelbroking/market/v1/quote/",
    "POST",
    getHeaders(jwt),
    { mode: "FULL", exchangeTokens: { [exchange]: tokenList } }
  );

  return res?.data?.fetched || [];
}

async function fetchCandles(jwt, exchange, symboltoken, interval, minsBack) {
  const to = new Date();
  const from = new Date(Date.now() - minsBack * 60 * 1000);

  const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");

  const res = await requestAngel(
    "/rest/secure/angelbroking/historical/v1/getCandleData",
    "POST",
    getHeaders(jwt),
    {
      exchange,
      symboltoken,
      interval,
      fromdate: fmt(from),
      todate: fmt(to)
    }
  );

  // data is typically [[time,open,high,low,close,volume], ...]
  return res?.data || [];
}

// =============================================
// DATA NORMALIZATION
// =============================================
function buildMarketData(item, exchange) {
  const ltp = Number(item.ltp || 0);
  const close = Number(item.close || ltp);
  const high = Number(item.high || ltp);
  const low = Number(item.low || ltp);

  return {
    name: item.tradingSymbol || item.symbol || "Unknown",
    token: item.symbolToken,
    exchange,
    ltp,
    open: Number(item.open || ltp),
    high,
    low,
    close,
    range: high - low,
    changePct: close ? ((ltp - close) / close) * 100 : 0
  };
}

// =============================================
// LIGHT INDICATORS (VWAP + EMA)
// =============================================
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function vwap(candles) {
  if (!candles || !candles.length) return null;
  let pv = 0, vol = 0;
  for (const c of candles) {
    const high = Number(c[2]), low = Number(c[3]), close = Number(c[4]), volume = Number(c[5] || 0);
    const tp = (high + low + close) / 3;
    pv += tp * volume;
    vol += volume;
  }
  return vol ? pv / vol : null;
}

// =============================================
// ANTI-WHIPSAW STABILIZER
// - signal must persist for 3 cycles before switching
// - cooldown prevents fast flip-flop
// =============================================
const SIGNAL_STATE = {}; // key -> {last, pending, count, cooldownUntil}

function stabilize(key, rawSignal) {
  const now = Date.now();
  if (!SIGNAL_STATE[key]) {
    SIGNAL_STATE[key] = { last: "HOLD", pending: "HOLD", count: 0, cooldownUntil: 0 };
  }
  const st = SIGNAL_STATE[key];

  // cooldown lock
  if (now < st.cooldownUntil) return st.last;

  if (rawSignal === st.last) {
    st.pending = rawSignal;
    st.count = 0;
    return st.last;
  }

  if (rawSignal !== st.pending) {
    st.pending = rawSignal;
    st.count = 1;
  } else {
    st.count += 1;
  }

  if (st.count >= 3) {
    st.last = st.pending;
    st.count = 0;
    // 30s cooldown after a flip
    st.cooldownUntil = now + 30 * 1000;
  }

  return st.last;
}

// =============================================
// SIGNAL ENGINE (Simple + Filters)
// - Uses your momentum/structure idea but adds VWAP/EMA check when available
// =============================================
function baseSignal(i) {
  if (i.changePct > 0.6) return "BUY";
  if (i.changePct < -0.6) return "SELL";
  return "HOLD";
}

function structureOk(i) {
  if (!i.ltp || i.range <= 0) return false;
  const vol = (i.range / i.ltp) * 100;
  const strength = Math.abs(i.changePct);
  return strength > vol * 0.3;
}

function riskScore(i, isCommodity = false) {
  let r = Math.abs(i.changePct) * 8;
  const vol = (i.range / i.ltp) * 100;
  r += vol * 2;
  if (isCommodity) r += 12;
  return Math.min(100, Math.round(r));
}

function optionStrikeSuggestion(name, ltp, signal) {
  const s = String(name || "").toUpperCase();

  // Only meaningful for index options
  const isNifty = s.includes("NIFTY") && !s.includes("BANK");
  const isBank = s.includes("BANKNIFTY") || s.includes("NIFTY BANK");
  const isFin = s.includes("FINNIFTY") || s.includes("NIFTY FIN");
  const isSensex = s.includes("SENSEX");

  if (!(isNifty || isBank || isFin || isSensex)) return "";

  let step = 50;
  if (isBank) step = 100;
  if (isSensex) step = 100;

  const strike = Math.round(Number(ltp) / step) * step;

  // Use Angel naming style user wants: NIFTY/BANKNIFTY/FINNIFTY/SENSEX
  const label = isBank ? "BANKNIFTY" : isFin ? "FINNIFTY" : isSensex ? "SENSEX" : "NIFTY";

  if (signal === "BUY") return `BUY ${label} ${strike} CE`;
  if (signal === "SELL") return `BUY ${label} ${strike} PE`;
  return "NO TRADE";
}

// =============================================
// API
// =============================================

// Health
app.get("/", (req, res) => {
  res.json({
    status: "TradePro Engine (stable login + scrip master)",
    scripMasterLoaded: SCRIP_READY,
    features: ["login", "fetch_all", "search", "watchlist_add", "watchlist_remove", "watchlist_get"]
  });
});

// Single API endpoint (same as your app expects) :contentReference[oaicite:4]{index=4}
app.post("/api/angel", async (req, res) => {
  const { action, mpin, totp, token, query, symbol, type } = req.body;

  try {
    // ===== LOGIN (KEEP SAME ENDPOINT + https.request) ===== :contentReference[oaicite:5]{index=5}
    if (action === "login") {
      const login = await requestAngel(
        "/rest/auth/angelbroking/user/v1/loginByPassword",
        "POST",
        {
          "X-PrivateKey": CONFIG.apiKey,
          "Content-Type": "application/json",
          "X-SourceID": "WEB",
          "X-UserType": "USER",
          "X-ClientLocalIP": "192.168.1.1",
          "X-ClientPublicIP": "106.193.147.98",
          "X-MACAddress": "00:00:00:00:00:00"
        },
        {
          clientcode: CONFIG.clientId,
          password: mpin,
          totp
        }
      );

      if (!login?.data?.jwtToken) {
        return res.status(401).json({ success: false, error: login?.message || "Login failed" });
      }

      return res.json({ success: true, token: login.data.jwtToken });
    }

    // ===== SEARCH (Dynamic) =====
    if (action === "search") {
      if (!SCRIP_READY) return res.json({ success: false, error: "Scrip master not loaded yet" });

      const q = String(query || "").trim();
      const exch = String(type || "").trim().toUpperCase(); // "NSE" | "BSE" | "MCX" | ""
      const found = bestMatchSymbol({ q, exch: exch || undefined });

      if (!found) return res.json({ success: true, result: null });

      return res.json({
        success: true,
        result: {
          symbol: found.symbol,
          name: found.name,
          token: found.token,
          exch_seg: found.exch_seg,
          expiry: found.expiry || ""
        }
      });
    }

    // ===== WATCHLIST GET =====
    if (action === "watchlist_get") {
      return res.json({
        success: true,
        data: {
          stocks: WATCHLIST_STOCKS,
          mcx: WATCHLIST_MCX
        }
      });
    }

    // ===== WATCHLIST ADD =====
    if (action === "watchlist_add") {
      const s = String(symbol || "").trim();
      const t = String(type || "").trim().toUpperCase(); // "STOCK" | "MCX"
      if (!s) return res.json({ success: false, error: "symbol required" });

      if (t === "MCX") {
        if (!WATCHLIST_MCX.includes(s.toUpperCase())) WATCHLIST_MCX.push(s.toUpperCase());
      } else {
        if (!WATCHLIST_STOCKS.includes(s.toUpperCase())) WATCHLIST_STOCKS.push(s.toUpperCase());
      }
      return res.json({ success: true });
    }

    // ===== WATCHLIST REMOVE =====
    if (action === "watchlist_remove") {
      const s = String(symbol || "").trim().toUpperCase();
      const t = String(type || "").trim().toUpperCase(); // "STOCK" | "MCX"
      if (!s) return res.json({ success: false, error: "symbol required" });

      if (t === "MCX") WATCHLIST_MCX = WATCHLIST_MCX.filter((x) => x !== s);
      else WATCHLIST_STOCKS = WATCHLIST_STOCKS.filter((x) => x !== s);

      return res.json({ success: true });
    }

    // ===== FETCH ALL =====
    if (action === "fetch_all") {
      if (!token) return res.status(401).json({ success: false, error: "Missing token" });

      // Resolve dynamic stock tokens (NSE)
      const stockTokens = [];
      const stockMeta = [];

      if (SCRIP_READY) {
        for (const s of WATCHLIST_STOCKS.slice(0, 40)) {
          const match = bestMatchSymbol({ q: s, exch: "NSE" });
          if (match?.token) {
            stockTokens.push(String(match.token));
            stockMeta.push({ key: s, token: String(match.token), exch: "NSE", name: match.symbol || match.name || s });
          }
        }
      }

      // Resolve dynamic MCX tokens (nearest expiry)
      const mcxTokens = [];
      const mcxMeta = [];

      if (SCRIP_READY) {
        for (const s of WATCHLIST_MCX.slice(0, 20)) {
          const match = bestMatchSymbol({ q: s, exch: "MCX" });
          if (match?.token) {
            mcxTokens.push(String(match.token));
            mcxMeta.push({ key: s, token: String(match.token), exch: "MCX", name: match.symbol || match.name || s, expiry: match.expiry || "" });
          }
        }
      }

      // Quote calls (indices are token-stable)
      const [nseIdxRaw, bseIdxRaw, stocksRaw, mcxRaw] = await Promise.all([
        fetchQuotes(token, "NSE", NSE_INDICES),
        fetchQuotes(token, "BSE", BSE_INDICES),
        stockTokens.length ? fetchQuotes(token, "NSE", stockTokens) : Promise.resolve([]),
        mcxTokens.length ? fetchQuotes(token, "MCX", mcxTokens) : Promise.resolve([])
      ]);

      // Normalize
      const indices = [];
      for (const x of (nseIdxRaw || [])) indices.push(buildMarketData(x, "NSE"));
      for (const x of (bseIdxRaw || [])) indices.push(buildMarketData(x, "BSE"));

      const stocks = (stocksRaw || []).map((x) => buildMarketData(x, "NSE"));
      const commodities = (mcxRaw || []).map((x) => buildMarketData(x, "MCX"));

      // Add engine results (lightweight)
      const enhance = async (arr, isCommodity) => {
        const out = [];

        for (const item of arr) {
          const raw = baseSignal(item);
          const ok = structureOk(item);
          const risk = riskScore(item, isCommodity);
          const mode = risk < 40 ? "MODE1" : "MODE2";

          // Optional VWAP/EMA filter ONLY for indices (keeps Render stable)
          // If you want it for all, you can later toggle "deep" mode.
          let ema200Val = null;
          let vwapVal = null;
          let filteredSignal = raw;

          const isIndex = String(item.exchange).toUpperCase() === "NSE" && String(item.token || "").startsWith("999");
          if (isIndex) {
            try {
              const candles = await fetchCandles(token, item.exchange, item.token, "FIVE_MINUTE", 24 * 60); // 1 day
              const closes = candles.map((c) => Number(c[4]));
              ema200Val = ema(closes.slice(-220), 200); // safe slice
              vwapVal = vwap(candles);

              if (ema200Val && vwapVal) {
                if (raw === "BUY" && !(item.ltp > ema200Val && item.ltp > vwapVal)) filteredSignal = "HOLD";
                if (raw === "SELL" && !(item.ltp < ema200Val && item.ltp < vwapVal)) filteredSignal = "HOLD";
              }
            } catch (e) {
              // If candle fetch fails, fall back to raw signal (don’t break UI)
            }
          }

          // Final decision
          let signal = "HOLD";
          let warning = "";

          if (filteredSignal !== "HOLD" && ok) signal = filteredSignal;
          if (filteredSignal !== "HOLD" && !ok) warning = "Structure weak (blocked)";
          if (risk >= 40) warning = warning ? `${warning} | ⚠️ Higher Risk` : "⚠️ Higher Risk";

          // Anti-whipsaw stabilize
          const stable = stabilize(item.name, signal);

          // Trade string
          let trade = "NO TRADE";
          const opt = optionStrikeSuggestion(item.name, item.ltp, stable);

          if (opt) trade = opt;
          else if (stable === "BUY") trade = `BUY ${String(item.name).toUpperCase()}`;
          else if (stable === "SELL") trade = `SELL ${String(item.name).toUpperCase()}`;

          // Basic SL/Target (simple & stable)
          const slPoints = Math.max(0.2 * item.range, 0.001 * item.ltp);
          const tgPoints = slPoints * 2;

          const stopLoss =
            stable === "BUY" ? item.ltp - slPoints :
            stable === "SELL" ? item.ltp + slPoints :
            null;

          const target =
            stable === "BUY" ? item.ltp + tgPoints :
            stable === "SELL" ? item.ltp - tgPoints :
            null;

          out.push({
            ...item,
            engine: {
              signal: stable,
              mode,
              risk,
              warning,
              ema200: ema200Val,
              vwap: vwapVal,
              trade,
              entry: item.ltp,
              stopLoss,
              target
            }
          });
        }

        return out;
      };

      const [indicesOut, commoditiesOut, stocksOut] = await Promise.all([
        enhance(indices, false),
        enhance(commodities, true),
        enhance(stocks, false)
      ]);

      return res.json({
        success: true,
        data: {
          indices: indicesOut,
          commodities: commoditiesOut,
          stocks: stocksOut,
          meta: {
            scripMasterLoaded: SCRIP_READY,
            stocksResolved: stockMeta.length,
            mcxResolved: mcxMeta.length
          }
        }
      });
    }

    return res.json({ success: false, error: "Invalid action" });
  } catch (e) {
    console.error("ENGINE ERROR:", e);
    return res.status(500).json({ success: false, error: e.message || "Internal error" });
  }
});

// =============================================
app.listen(PORT, async () => {
  console.log("🚀 TradePro stable engine running on", PORT);
  await loadScripMaster(); // non-fatal if it fails
});
