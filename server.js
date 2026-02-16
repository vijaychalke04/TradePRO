/**
 * Trade Genie / TradePro backend
 * - AngelOne SmartAPI proxy (login + quote + fetch_all)
 * - MCX resolved + MCX LTP (uses Angel quote API)
 *
 * ENV (Render):
 *   ANGEL_API_KEY     = SmartAPI API Key (private key)
 *   ANGEL_CLIENT_ID   = Client Code (e.g. V12345678)
 *   TELEGRAM_TOKEN    = bot token (optional)
 *   TELEGRAM_CHAT_ID  = chat id (optional)
 *
 * Notes:
 * - Frontend can still pass token explicitly (req.body.token or Authorization Bearer),
 *   but server also stores the last successful login token in-memory so fetch_all works even if token missing.
 */

"use strict";

const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Angel-Token"],
  })
);
app.use(express.json({ limit: "2mb" }));

// -----------------------------
// Config / ENV
// -----------------------------
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "",
  clientId: process.env.ANGEL_CLIENT_ID || "",
  telegramToken: process.env.TELEGRAM_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};

// In-memory session (single-user use-case)
const SESSION = {
  token: "", // jwtToken
  feedToken: "",
  refreshToken: "",
  updatedAt: 0,
};

function requireEnv() {
  const missing = [];
  if (!CONFIG.apiKey) missing.push("ANGEL_API_KEY");
  if (!CONFIG.clientId) missing.push("ANGEL_CLIENT_ID");
  return missing;
}

// -----------------------------
// Low-level AngelOne request helper (HTTPS)
// -----------------------------
const ANGEL_HOST = "apiconnect.angelone.in";

function httpsJson(pathname, method, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
    const opts = {
      hostname: ANGEL_HOST,
      path: pathname,
      method,
      headers: {
        Accept: "application/json",
        ...(headers || {}),
      },
    };

    if (bodyStr) {
      opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch (_) {}
        resolve({ status: res.statusCode || 0, body: json, raw: data });
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function angelHeaders(token) {
  return {
    "X-PrivateKey": CONFIG.apiKey,
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function pickTokenFromRequest(req) {
  // 1) Explicit token in body
  const bodyToken = req.body && typeof req.body.token === "string" ? req.body.token : "";
  if (bodyToken) return bodyToken;

  // 2) Custom header
  const hdr = req.headers["x-angel-token"];
  if (typeof hdr === "string" && hdr.trim()) return hdr.trim();

  // 3) Authorization Bearer
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  // 4) Fallback to session token
  return SESSION.token || "";
}

// -----------------------------
// Quote cache (helps when market closed / intermittent)
// -----------------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const QUOTE_CACHE_PATH = path.join(DATA_DIR, "lastQuotes.json");
let QUOTE_CACHE = { updatedAt: 0, byToken: {} };

try {
  if (fs.existsSync(QUOTE_CACHE_PATH)) {
    QUOTE_CACHE = JSON.parse(fs.readFileSync(QUOTE_CACHE_PATH, "utf8"));
    if (!QUOTE_CACHE || typeof QUOTE_CACHE !== "object") QUOTE_CACHE = { updatedAt: 0, byToken: {} };
    if (!QUOTE_CACHE.byToken) QUOTE_CACHE.byToken = {};
  }
} catch (_) {
  QUOTE_CACHE = { updatedAt: 0, byToken: {} };
}

function cacheFetchedQuotes(list) {
  const now = Date.now();
  QUOTE_CACHE.updatedAt = now;
  if (!QUOTE_CACHE.byToken) QUOTE_CACHE.byToken = {};
  for (const item of list || []) {
    const token = String(item?.symbolToken || item?.token || "");
    if (!token) continue;
    const ltp = Number(item?.ltp ?? item?.lastTradedPrice ?? item?.last_traded_price ?? item?.lasttradedprice);
    if (!Number.isFinite(ltp)) continue;
    QUOTE_CACHE.byToken[token] = { ...item, ltp, _cachedAt: now };
  }
  try {
    fs.writeFileSync(QUOTE_CACHE_PATH, JSON.stringify(QUOTE_CACHE, null, 2));
  } catch (_) {}
}

// -----------------------------
// AngelOne API wrappers
// -----------------------------
async function angelLoginByPassword({ mpin, totp }) {
  // SmartAPI expects "password" even if you're using MPIN (common workaround), plus totp for 2FA.
  const payload = { clientcode: CONFIG.clientId, password: mpin, totp };
  const res = await httpsJson(
    "/rest/auth/angelbroking/user/v1/loginByPassword",
    "POST",
    {
      ...angelHeaders(""),
      "Content-Type": "application/json",
    },
    payload
  );

  if (!res.body || res.body.status !== true) {
    const msg = res.body?.message || res.body?.error?.message || res.raw || "Login failed";
    throw new Error(msg);
  }

  const data = res.body.data || {};
  if (data.jwtToken) SESSION.token = data.jwtToken;
  if (data.feedToken) SESSION.feedToken = data.feedToken;
  if (data.refreshToken) SESSION.refreshToken = data.refreshToken;
  SESSION.updatedAt = Date.now();

  return { jwtToken: data.jwtToken || "", feedToken: data.feedToken || "", refreshToken: data.refreshToken || "" };
}

async function angelQuoteFull({ token, exchange, tokens }) {
  const res = await httpsJson(
    "/rest/secure/angelbroking/market/v1/quote/",
    "POST",
    {
      ...angelHeaders(token),
      "Content-Type": "application/json",
    },
    {
      mode: "FULL",
      exchangeTokens: { [exchange]: tokens },
    }
  );

  if (!res.body || res.body.status !== true) {
    const msg = res.body?.message || res.body?.error?.message || res.raw || "Quote fetch failed";
    throw new Error(msg);
  }

  const fetched = res.body?.data?.fetched || [];
  if (Array.isArray(fetched) && fetched.length) cacheFetchedQuotes(fetched);
  return fetched;
}

// -----------------------------
// MCX token resolution (static "picked" set)
// -----------------------------
const MCX_RESOLVED = {
  picked: [
    { label: "GOLDM", token: "491762", symbol: "GOLDM26FEB26131400CE", expiry: "26FEB2026" },
    { label: "SILVERM", token: "451937", symbol: "SILVERM18FEB26105000CE", expiry: "18FEB2026" },
    { label: "CRUDEOIL", token: "488297", symbol: "CRUDEOIL17FEB265200CE", expiry: "17FEB2026" },
    { label: "NATGAS", token: "488509", symbol: "NATGASMINI20FEB26340CE", expiry: "20FEB2026" },
  ],
};

// -----------------------------
// Health
// -----------------------------
app.get("/api/health", (req, res) => {
  const missing = requireEnv();
  res.json({
    ok: missing.length === 0,
    missing,
    session: { hasToken: !!SESSION.token, updatedAt: SESSION.updatedAt },
    cache: { updatedAt: QUOTE_CACHE.updatedAt, tokensCached: Object.keys(QUOTE_CACHE.byToken || {}).length },
  });
});

// -----------------------------
// MCX routes
// -----------------------------
app.get("/api/mcx/resolved", (req, res) => {
  res.json({ success: true, resolved: { updatedAt: Date.now(), picked: MCX_RESOLVED.picked } });
});

app.get("/api/mcx/ltp", async (req, res) => {
  try {
    const missing = requireEnv();
    if (missing.length) return res.status(400).json({ success: false, error: `Missing env: ${missing.join(", ")}` });

    const token = pickTokenFromRequest(req);

    // If no token, return cache (best-effort) instead of failing
    if (!token) {
      const cached = (MCX_RESOLVED.picked || []).map((p) => {
        const c = QUOTE_CACHE.byToken?.[String(p.token)];
        return {
          label: p.label,
          token: p.token,
          symbol: p.symbol,
          expiry: p.expiry,
          ltp: c?.ltp ?? null,
          _cachedAt: c?._cachedAt ?? null,
        };
      });
      return res.json({ success: true, source: "cache", data: cached });
    }

    const tokens = (MCX_RESOLVED.picked || []).map((p) => String(p.token));
    const fetched = await angelQuoteFull({ token, exchange: "MCX", tokens });

    const byToken = new Map();
    for (const f of fetched) {
      const t = String(f?.symbolToken || f?.token || "");
      if (t) byToken.set(t, f);
    }

    const data = (MCX_RESOLVED.picked || []).map((p) => {
      const f = byToken.get(String(p.token)) || QUOTE_CACHE.byToken?.[String(p.token)] || null;
      const ltp = f ? Number(f?.ltp ?? f?.lastTradedPrice ?? f?.last_traded_price) : null;
      return { ...p, ltp: Number.isFinite(ltp) ? ltp : null };
    });

    res.json({ success: true, source: "live", data });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// -----------------------------
// Main Angel proxy route (used by your HTML)
// -----------------------------
app.post("/api/angel", async (req, res) => {
  try {
    const action = req.body?.action;

    const missing = requireEnv();
    if (missing.length) return res.status(400).json({ success: false, error: `Missing env: ${missing.join(", ")}` });

    if (action === "login") {
      const mpin = String(req.body?.mpin || "").trim();
      const totp = String(req.body?.totp || "").trim();
      if (!mpin || !totp) return res.status(400).json({ success: false, error: "mpin and totp are required" });

      const data = await angelLoginByPassword({ mpin, totp });
      return res.json({ success: true, data });
    }

    if (action === "fetch_all") {
      const token = pickTokenFromRequest(req);
      if (!token)
        return res.status(401).json({ success: false, error: "Not logged in (missing token). Use action=login first." });

      // Indices (NSE)
      const indices = [
        { name: "Nifty Fin Service", token: "99926037", exchange: "NSE" },
        { name: "Nifty 50", token: "99926000", exchange: "NSE" },
        { name: "Nifty Bank", token: "99926009", exchange: "NSE" },
        { name: "India VIX", token: "99926017", exchange: "NSE" },
      ];

      const idxTokens = indices.map((i) => i.token);
      const idxFetched = await angelQuoteFull({ token, exchange: "NSE", tokens: idxTokens });

      const idxByToken = new Map();
      for (const f of idxFetched) idxByToken.set(String(f?.symbolToken || f?.token || ""), f);

      const indicesOut = indices.map((i) => {
        const q = idxByToken.get(String(i.token)) || QUOTE_CACHE.byToken?.[String(i.token)] || {};
        const ltp = Number(q?.ltp ?? q?.lastTradedPrice ?? q?.last_traded_price);
        const open = Number(q?.open ?? q?.opn);
        const high = Number(q?.high ?? q?.hgh);
        const low = Number(q?.low);
        const close = Number(q?.close ?? q?.cls);
        const changePct = Number(q?.netChangePercent ?? q?.netChangePercentage ?? q?.netChangePerc);

        return {
          ...i,
          ltp: Number.isFinite(ltp) ? ltp : null,
          open: Number.isFinite(open) ? open : null,
          high: Number.isFinite(high) ? high : null,
          low: Number.isFinite(low) ? low : null,
          close: Number.isFinite(close) ? close : null,
          changePct: Number.isFinite(changePct) ? changePct : null,
          engine: {},
        };
      });

      // MCX best-effort
      let commoditiesOut = [];
      try {
        const tokens = (MCX_RESOLVED.picked || []).map((p) => String(p.token));
        const fetched = await angelQuoteFull({ token, exchange: "MCX", tokens });
        const byToken = new Map();
        for (const f of fetched) byToken.set(String(f?.symbolToken || f?.token || ""), f);

        commoditiesOut = (MCX_RESOLVED.picked || []).map((p) => {
          const f = byToken.get(String(p.token)) || QUOTE_CACHE.byToken?.[String(p.token)] || null;
          const ltp = f ? Number(f?.ltp ?? f?.lastTradedPrice ?? f?.last_traded_price) : null;
          return {
            name: p.symbol,
            token: p.token,
            exchange: "MCX",
            ltp: Number.isFinite(ltp) ? ltp : null,
            engine: {},
          };
        });
      } catch (_) {
        commoditiesOut = (MCX_RESOLVED.picked || []).map((p) => {
          const c = QUOTE_CACHE.byToken?.[String(p.token)];
          return { name: p.symbol, token: p.token, exchange: "MCX", ltp: c?.ltp ?? null, engine: {} };
        });
      }

      return res.json({ success: true, data: { indices: indicesOut, commodities: commoditiesOut, stocks: [] } });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// -----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 FINAL ROBUST ENGINE running on", PORT));
