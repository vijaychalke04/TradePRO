// =============================================
// TRADE GENIE ULTRA-PRO MASTER ENGINE (V10.1)
// =============================================
const express = require("express");
const cors = require("cors");
const https = require("https");
const axios = require("axios");
const TelegramBot = require('node-telegram-bot-api');
const TI = require("technicalindicators");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CONFIG = {
    apiKey: process.env.ANGEL_API_KEY,
    clientId: process.env.ANGEL_CLIENT_ID,
    telegramToken: process.env.TELEGRAM_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    baseURL: "apiconnect.angelone.in"
};

// --- DATA CACHE ---
let SESSION_TOKEN = "";
const MCX_TOKENS = ["491762", "451937", "488297", "488509"]; // GoldM, SilverM, Crude, NatGas

// --- HELPER: ANGEL API REQUEST ---
function requestAngel(path, method, body, token = null) {
    return new Promise((resolve, reject) => {
        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-UserType": "USER",
            "X-SourceID": "WEB",
            "X-PrivateKey": CONFIG.apiKey,
            "X-ClientLocalIP": "127.0.0.1",
            "X-ClientPublicIP": "127.0.0.1",
            "X-MACAddress": "00:00:00:00:00:00"
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const req = https.request({ hostname: CONFIG.baseURL, path, method, headers }, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve({ status: false, error: "Invalid JSON" }); }
            });
        });
        req.on("error", reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// --- ROUTES ---

// 1. MASTER API: Login & Data Fetching
app.post("/api/angel", async (req, res) => {
    const { action, mpin, totp, token } = req.body;
    const activeToken = token || SESSION_TOKEN;

    try {
        if (action === "login") {
            const loginRes = await requestAngel("/rest/auth/angelbroking/user/v1/loginByPassword", "POST", { clientcode: CONFIG.clientId, password: mpin, totp });
            if (loginRes.status) {
                SESSION_TOKEN = loginRes.data.jwtToken;
                return res.json({ success: true, token: SESSION_TOKEN });
            }
            return res.status(401).json({ success: false, error: loginRes.message });
        }

        if (action === "fetch_all") {
            // Fetch Indices
            const idxRes = await requestAngel("/rest/secure/angelbroking/market/v1/quote/", "POST", { mode: "FULL", exchangeTokens: { "NSE": ["99926000", "99926009", "99926037"] } }, activeToken);
            // Fetch Commodities
            const comRes = await requestAngel("/rest/secure/angelbroking/market/v1/quote/", "POST", { mode: "FULL", exchangeTokens: { "MCX": MCX_TOKENS } }, activeToken);

            const indices = (idxRes.data?.fetched || []).map(q => ({
                name: q.tradingSymbol, token: q.symbolToken, ltp: q.ltp, changePct: q.netChangePercent,
                engine: { signal: "HOLD", trade: "WAIT", mode: "MODE1" }
            }));

            const commodities = (comRes.data?.fetched || []).map(q => ({
                name: q.tradingSymbol, token: q.symbolToken, ltp: q.ltp,
                engine: { signal: "HOLD", trade: "WAIT", mode: "MODE1" }
            }));

            res.json({ success: true, data: { indices, commodities, stocks: [] } });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 2. MONTE CARLO ROUTE
app.post("/api/backtest/montecarlo", (req, res) => {
    const { s0 = 25000 } = req.body;
    let finals = [];
    for (let i = 0; i < 1000; i++) {
        let price = s0;
        for (let d = 0; d < 20; d++) price *= (1 + (Math.random() - 0.48) * 0.02);
        finals.push(price);
    }
    finals.sort((a, b) => a - b);
    res.json({
        success: true,
        stats: {
            winProbAbovePlus0_5pct: ((finals.filter(p => p >= s0 * 1.005).length / 1000) * 100).toFixed(1),
            p10: finals[100].toFixed(2), p50: finals[500].toFixed(2), p90: finals[900].toFixed(2)
        }
    });
});

app.listen(PORT, () => console.log(`🚀 Master V10.1 Active on Port ${PORT}`));
