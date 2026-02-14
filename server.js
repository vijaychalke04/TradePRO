"use strict";

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const helmet = require("helmet");

const app = express();
app.use(cors());
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false }));

const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "JkFNQiMO",
  clientId: process.env.ANGEL_CLIENT_ID || "V58776779",
  baseURL: "https://apiconnect.angelone.in"
};

// ================= ENDPOINTS =================
const LOGIN_URL = `${CONFIG.baseURL}/rest/auth/angelbroking/user/v1/loginByPassword`;
const QUOTE_URL = `${CONFIG.baseURL}/rest/secure/angelbroking/market/v1/quote/`;
const CANDLE_URL = `${CONFIG.baseURL}/rest/secure/angelbroking/historical/v1/getCandleData`;
const SCRIP_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

// ================= GLOBAL =================
let SCRIP_MASTER = [];
let WATCHLIST = [];
let SIGNAL_STATE = {};
const MAX_WATCH = 10;

// ================= LOAD SCRIP MASTER =================
async function loadScripMaster() {
  const res = await axios.get(SCRIP_URL);
  SCRIP_MASTER = res.data || [];
  console.log("Scrip Master Loaded:", SCRIP_MASTER.length);
}

function findSymbol(query) {
  query = query.toUpperCase();
  return SCRIP_MASTER.find(s =>
    s.symbol.toUpperCase().includes(query)
  );
}

// ================= INDICATORS =================
function EMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function VWAP(candles) {
  let pv = 0;
  let vol = 0;
  candles.forEach(c => {
    const tp = (c[2] + c[3] + c[4]) / 3;
    pv += tp * c[5];
    vol += c[5];
  });
  return vol ? pv / vol : null;
}

// ================= SIGNAL STABILIZATION =================
function stabilize(key, signal) {
  if (!SIGNAL_STATE[key]) {
    SIGNAL_STATE[key] = { last: "HOLD", count: 0 };
  }

  if (SIGNAL_STATE[key].last === signal) {
    SIGNAL_STATE[key].count = 0;
    return signal;
  }

  SIGNAL_STATE[key].count++;

  if (SIGNAL_STATE[key].count >= 3) {
    SIGNAL_STATE[key].last = signal;
    SIGNAL_STATE[key].count = 0;
  }

  return SIGNAL_STATE[key].last;
}

// ================= OPTION STRIKE =================
function optionSuggestion(symbol, ltp, signal) {
  const s = symbol.toUpperCase();
  let step = 50;

  if (s.includes("BANK")) step = 100;
  if (s.includes("SENSEX")) step = 100;

  const strike = Math.round(ltp / step) * step;

  if (signal === "BUY") return `BUY ${s} ${strike} CE`;
  if (signal === "SELL") return `BUY ${s} ${strike} PE`;

  return "NO TRADE";
}

// ================= LOGIN =================
async function loginAngel(mpin, totp) {
  const res = await axios.post(
    LOGIN_URL,
    {
      clientcode: CONFIG.clientId,
      password: mpin,
      totp: totp
    },
    {
      headers: {
        "X-PrivateKey": CONFIG.apiKey,
        "Content-Type": "application/json"
      }
    }
  );

  if (!res.data.status) throw new Error(res.data.message);
  return res.data.data.jwtToken;
}

// ================= API ROUTE =================
app.post("/api/angel", async (req, res) => {
  try {
    const { action } = req.body;

    if (action === "login") {
      const token = await loginAngel(req.body.mpin, req.body.totp);
      return res.json({ success: true, token });
    }

    const jwt = req.body.token;

    if (action === "add") {
      if (WATCHLIST.length >= MAX_WATCH)
        return res.json({ success: false, message: "Watchlist limit reached" });

      const found = findSymbol(req.body.symbol);
      if (!found) return res.json({ success: false });

      WATCHLIST.push(found);
      return res.json({ success: true });
    }

    if (action === "fetch") {
      let output = [];

      for (let s of WATCHLIST.slice(0, MAX_WATCH)) {

        const quote = await axios.post(
          QUOTE_URL,
          {
            mode: "FULL",
            exchangeTokens: { [s.exch_seg]: [s.token] }
          },
          {
            headers: {
              Authorization: `Bearer ${jwt}`,
              "X-PrivateKey": CONFIG.apiKey
            }
          }
        );

        const q = quote.data.data.fetched[0];
        const ltp = q.ltp;

        const candlesRes = await axios.post(
          CANDLE_URL,
          {
            exchange: s.exch_seg,
            symboltoken: s.token,
            interval: "FIVE_MINUTE",
            fromdate: new Date(Date.now() - 200 * 5 * 60000)
              .toISOString()
              .slice(0, 19)
              .replace("T", " "),
            todate: new Date()
              .toISOString()
              .slice(0, 19)
              .replace("T", " ")
          },
          {
            headers: {
              Authorization: `Bearer ${jwt}`,
              "X-PrivateKey": CONFIG.apiKey
            }
          }
        );

        const candles = candlesRes.data.data || [];
        const closes = candles.map(c => c[4]);

        const ema200 = EMA(closes, 200);
        const vwap = VWAP(candles);

        let signal = "HOLD";
        if (ema200 && vwap) {
          if (ltp > ema200 && ltp > vwap) signal = "BUY";
          if (ltp < ema200 && ltp < vwap) signal = "SELL";
        }

        signal = stabilize(s.symbol, signal);

        const trade = optionSuggestion(s.symbol, ltp, signal);

        output.push({
          name: s.symbol,
          ltp,
          signal,
          trade,
          entry: ltp,
          stopLoss: signal === "BUY" ? ltp - 20 : ltp + 20,
          target: signal === "BUY" ? ltp + 40 : ltp - 40
        });
      }

      return res.json({ success: true, data: output });
    }

    return res.json({ success: false });

  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// ================= START =================
app.listen(PORT, async () => {
  await loadScripMaster();
  console.log("TradePro running on port", PORT);
});
