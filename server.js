// =============================================
// TRADE GENIE - FINAL ROBUST ENGINE
// Render Free Tier Optimized
// =============================================

const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env?.PORT || 3000;

// =============================================
// CONFIG
// =============================================
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "JkFNQiMO",
  clientId: process.env.ANGEL_CLIENT_ID || "V58776779",
  baseURL: "apiconnect.angelone.in"
};

// =============================================
// OPTIONAL TELEGRAM ALERTS (no extra dependencies)
// Set env: TELEGRAM_TOKEN and TELEGRAM_CHAT_ID
// Note: sending alerts is best-effort; it won't crash the server.
// =============================================
const TELEGRAM = {
  token: process.env.TELEGRAM_TOKEN || "",
  chatId: process.env.TELEGRAM_CHAT_ID || ""
};

function sendTelegramAlert(message){
  try{
    if(!TELEGRAM.token || !TELEGRAM.chatId) return;
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
        headers: { "Content-Type":"application/json", "Content-Length": Buffer.byteLength(payload) }
      },
      res => { res.on("data", ()=>{}); res.on("end", ()=>{}); }
    );
    req.on("error", ()=>{});
    req.write(payload);
    req.end();
  }catch(e){}
}

// =============================================
// Greeks (safe, dependency-free)
// - Uses Black–Scholes for Delta/Gamma/Vega/Theta (approx)
// - Requires: underlying price S, strike K, time-to-expiry (years), rate r, IV sigma
// NOTE: This does NOT fetch options-chain/IV. You provide inputs.
// =============================================
const Greeks = {
  _pdf: (x)=> Math.exp(-0.5*x*x) / Math.sqrt(2*Math.PI),
  _cdf: (x)=> {
    // Abramowitz-Stegun approximation
    const a1=0.3193815,a2=-0.3565638,a3=1.781478,a4=-1.821256,a5=1.330274;
    const L = Math.abs(x);
    const k = 1/(1+0.2316419*L);
    const w = 1 - Greeks._pdf(L)*(a1*k + a2*k*k + a3*k*k*k + a4*k*k*k*k + a5*k*k*k*k*k);
    return x<0 ? 1-w : w;
  },
  compute: ({S,K,T,r=0.07,sigma=0.2,type="CE"})=>{
    S = Number(S); K = Number(K); T = Number(T); r = Number(r); sigma = Number(sigma);
    if(!(S>0 && K>0 && T>0 && sigma>0)) return { ok:false, error:"Invalid inputs. Need S,K,T,sigma > 0" };
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*sqrtT);
    const d2 = d1 - sigma*sqrtT;

    const Nd1 = Greeks._cdf(d1);
    const Nd2 = Greeks._cdf(d2);
    const nd1 = Greeks._pdf(d1);

    const isCall = String(type||"CE").toUpperCase().includes("C");
    const delta = isCall ? Nd1 : (Nd1 - 1);

    const gamma = nd1 / (S*sigma*sqrtT);
    const vega  = (S*nd1*sqrtT) / 100; // per 1% IV
    // Theta per day (rough)
    const theta = (-(S*nd1*sigma)/(2*sqrtT) - (isCall ? r*K*Math.exp(-r*T)*Nd2 : -r*K*Math.exp(-r*T)*Greeks._cdf(-d2))) / 365;

    return {
      ok:true,
      inputs:{ S,K,T,r,sigma,type: isCall ? "CE" : "PE" },
      d1:+d1.toFixed(4),
      d2:+d2.toFixed(4),
      delta:+delta.toFixed(4),
      gamma:+gamma.toFixed(6),
      vega:+vega.toFixed(4),
      theta:+theta.toFixed(4)
    };
  }
};

// =============================================
// INSTRUMENTS
// =============================================
const COM_TOKENS = ["257681","254721","258847","259304"];
// MCX contracts to track (nearest expiry futures).
// We try exact contract-name matches first (e.g., GOLDM, SILVERM, CRUDEOIL, NATGAS),
// then fall back to broader keywords (GOLD, SILVER, CRUDE, NATGAS).
const COM_CONTRACTS = [
  { label: "GOLDM",    keywords: ["GOLDM", "GOLD MINI", "GOLD-M"] },
  { label: "GOLD",     keywords: ["GOLD"] },
  { label: "SILVERM",  keywords: ["SILVERM", "SILVER MINI", "SILVER-M"] },
  { label: "SILVER",   keywords: ["SILVER"] },
  { label: "CRUDEOIL", keywords: ["CRUDEOIL", "CRUDE OIL", "CRUDE"] },
  { label: "NATGAS",   keywords: ["NATGAS", "NATURALGAS", "NATURAL GAS"] }
];

// resolved MCX picks for debugging/UI
let RESOLVED_MCX = { updatedAt: 0, picked: [] };

async function resolveMctxTokens(){
  try{
    await fetchScripMaster(false);
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const parseExpiry = (e)=>{
      try{
        e = String(e||"").trim();
        if(!e) return null;
        if(e.includes("-")){
          const d = new Date(e);
          return isNaN(d) ? null : d;
        }
        // DDMMMYYYY
        const dd = e.slice(0,2);
        const mmm = e.slice(2,5).toUpperCase();
        const yy = e.slice(5);
        const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
        const d = new Date(Number(yy), months[mmm] ?? 0, Number(dd));
        return isNaN(d) ? null : d;
      }catch{
        return null;
      }
    };

    const norm = (s)=> String(s||"").toUpperCase().replace(/\s+/g,"").replace(/-/g,"");

    const pickNearestFut = (keywords)=>{
      const kws = (keywords||[]).map(norm).filter(Boolean);

      const rows = (SCRIP_MASTER.rows||[]).filter(r=>{
        const seg = String(r.exch_seg||r.exchange||"").toUpperCase();
        if(seg !== "MCX") return false;

        const sym = norm(r.symbol || r.tradingsymbol || "");
        if(!sym) return false;

        const it = String(r.instrumenttype||r.instrument_type||"").toUpperCase();
        if(it && !(it.includes("FUT") || it.includes("FUTCOM"))) return false;

        return kws.some(kw => sym.includes(kw));
      });

      const parsed = rows
        .map(r=>({ r, exp: parseExpiry(r.expiry) }))
        .filter(x=>x.exp instanceof Date && !isNaN(x.exp));

      if(!parsed.length) return null;

      const future = parsed.filter(x=>x.exp >= startOfToday);
      const list = (future.length ? future : parsed).sort((a,b)=>a.exp-b.exp);
      return list[0]?.r || null;
    };

    const picked = [];
    const seen = new Set();

    for(const c of COM_CONTRACTS){
      const row = pickNearestFut(c.keywords);
      const token = row ? String(row.token||"") : "";
      if(token && !seen.has(token)){
        seen.add(token);
        picked.push({
          label: c.label,
          token,
          symbol: row.symbol || row.tradingsymbol || null,
          expiry: row.expiry || null
        });
      }
    }

    if(picked.length){
      COM_TOKENS.length = 0;
      picked.forEach(x=>COM_TOKENS.push(x.token));
      RESOLVED_MCX = { updatedAt: Date.now(), picked };
    }
  }catch(e){
    // ignore
  }
}

 // MCX
const STK_TOKENS = ["3045","11536","1333","1594","4963","1660","3787"]; // NSE EQ

const NSE_INDICES = ["99926000","99926009","99926037","99926017"];
const COMMODITIES = ["257681","254721","258847","259304"];
const STOCKS = ["3045","11536","1333","1594","4963","1660","3787"];

// =============================================
// REQUEST HELPER
// =============================================
function requestAngel(path, method, headers, data) {

  return new Promise((resolve,reject)=>{

    const req = https.request({
      hostname: CONFIG.baseURL,
      path,
      method,
      headers
    }, res=>{

      let body="";
      res.on("data",c=>body+=c);

      res.on("end",()=>{
        // Never reject on JSON parse error; return raw body so UI can see real problem.
        let parsed = null;
        try{
          parsed = body ? JSON.parse(body) : null;
        }catch(e){
          parsed = { parseError: e.message, raw: body || "" };
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });

    });

    req.on("error",reject);

    if(data) req.write(JSON.stringify(data));
    req.end();
  });
}

function getHeaders(token){
  return {
    Authorization:`Bearer ${token}`,
    "X-PrivateKey":CONFIG.apiKey,
    "Content-Type":"application/json",
    "X-SourceID":"WEB",
    "X-UserType":"USER"
  };
}

// =============================================
// DATA PROCESSING
// =============================================
function buildMarketData(item, exchange){

  const ltp = parseFloat(item.ltp || 0);
  const close = parseFloat(item.close || ltp);
  const high = parseFloat(item.high || ltp);
  const low = parseFloat(item.low || ltp);

  return {
    name:item.tradingSymbol || "Unknown",
    token:item.symbolToken,
    exchange,
    ltp,
    open:parseFloat(item.open || ltp),
    high,
    low,
    close,
    range: high-low,
    changePct: close ? ((ltp-close)/close)*100 : 0
  };
}

// =============================================
// ALPHA ENGINE (Momentum)
// =============================================
function alphaEngine(i){

  if(i.changePct > 0.6) return "BUY";
  if(i.changePct < -0.6) return "SELL";

  return "HOLD";
}

// =============================================
// BETA ENGINE (Structure)
// =============================================
function betaEngine(i){

  if(i.range === 0) return false;

  const volatility = (i.range / i.ltp) * 100;
  const strength = Math.abs(i.changePct);

  return strength > (volatility * 0.3);
}

// =============================================
// RISK ENGINE
// =============================================
function riskEngine(i, commodity=false){

  let risk = Math.abs(i.changePct) * 8;

  const vol = (i.range / i.ltp) * 100;
  risk += vol * 2;

  if(commodity) risk += 12;

  return Math.min(100, Math.round(risk));
}

// =============================================
// FINAL SIGNAL ENGINE
// =============================================
function signalEngine(i, commodity=false){

  const alpha = alphaEngine(i);
  const beta = betaEngine(i);
  const risk = riskEngine(i,commodity);
  const mode = risk < 40 ? "MODE1" : "MODE2";

  if(alpha === "HOLD"){
    return { signal:"HOLD", mode, risk };
  }

  if(!beta){
    return {
      signal:"HOLD",
      mode,
      risk,
      warning:"Structure weak (blocked)"
    };
  }

  return {
    signal:alpha,
    mode,
    risk,
    warning: risk >= 40 ? "⚠️ Higher Risk Trade" : ""
  };
}
// =============================================
// UI ENRICHMENT: ensure engine.trade/target/sl always exist for your HTML
// =============================================
// =============================================
// Signal Confirmation Buffer (anti flip-flop)
// - signal must be stable for N consecutive ticks to switch
// =============================================
const SIGNAL_BUFFER = {
  byToken: {},
  confirmTicks: 2
};

function applyConfirmationBuffer(token, rawSignal){
  const t = String(token || "");
  const s = String(rawSignal || "HOLD").toUpperCase();
  if(!t) return { signal: s, stabilizing: false };

  const st = SIGNAL_BUFFER.byToken[t] || { committed: "HOLD", pending: "HOLD", pendingCount: 0, lastTs: 0 };

  if(s === st.committed){
    st.pending = s;
    st.pendingCount = 0;
    st.lastTs = Date.now();
    SIGNAL_BUFFER.byToken[t] = st;
    return { signal: st.committed, stabilizing: false };
  }

  // raw differs from committed
  if(s === st.pending){
    st.pendingCount += 1;
  }else{
    st.pending = s;
    st.pendingCount = 1;
  }

  let stabilizing = true;
  if(st.pendingCount >= SIGNAL_BUFFER.confirmTicks){
    st.committed = st.pending;
    st.pendingCount = 0;
    stabilizing = false;
  }

  st.lastTs = Date.now();
  SIGNAL_BUFFER.byToken[t] = st;
  return { signal: st.committed, stabilizing };
}


// =============================================
// Options helper (strike suggestion based on underlying LTP)
// NOTE: This does NOT fetch option chain. It's a heuristic to pick a nearby strike.
// =============================================
function optionStrikeStep(ltp, isIndex){
  if(isIndex) return 50;
  const p = Number(ltp||0);
  if(p <= 0) return 50;
  if(p < 200) return 5;
  if(p < 500) return 10;
  if(p < 1000) return 20;
  if(p < 2000) return 50;
  return 100;
}
function roundToStep(x, step){
  return Math.round(x/step)*step;
}
function mapIndexUnderlying(name){
  const n = String(name||"").toUpperCase();
  if(n.includes("NIFTY BANK")) return "BANKNIFTY";
  if(n.includes("FIN SERVICE") || n.includes("FINNIFTY")) return "FINNIFTY";
  if(n.includes("MIDCAP") && n.includes("NIFTY")) return "MIDCPNIFTY";
  if(n.includes("NIFTY")) return "NIFTY";
  return String(name||"").trim() || "INDEX";
}

function suggestOption(name, ltp, direction, isIndex){
  const step = optionStrikeStep(ltp, isIndex);
  const price = Number(ltp||0);
  const dir = String(direction||"HOLD").toUpperCase();
  if(!(price>0) || (dir!=="BUY" && dir!=="SELL")) return null;

  // BUY => suggest CE; SELL => suggest PE
  const optType = (dir==="BUY") ? "CE" : "PE";
  let strikeBase = roundToStep(price, step);

  // push slightly OTM to reduce premium
  let strike = strikeBase;
  if(optType==="CE" && strike < price) strike += step;
  if(optType==="PE" && strike > price) strike -= step;

  const underlying = isIndex ? mapIndexUnderlying(name) : String(name||"").replace(/-EQ$/i,"").trim();
  const pretty = `${underlying} ${strike}${optType}`; // e.g. NIFTY 25500PE / 25600CE

  return {
    optionType: optType,
    strike,
    step,
    suggested: pretty,
    basis: isIndex ? "INDEX" : "STOCK"
  };
}


function enrichEngine(market, engine){
  const ltp = Number(market?.ltp || 0);
  const mode = engine?.mode || "MODE1";
  const rawSignal = engine?.signal || "HOLD";
  const buf = applyConfirmationBuffer(market?.token, rawSignal);
  const signal = buf.signal;


  // basic % by mode (feel free to tune)
  const tgtPct = mode==="MODE2" ? 0.020 : 0.010;   // 2% vs 1%
  const slPct  = mode==="MODE2" ? 0.010 : 0.005;   // 1% vs 0.5%

  let trade = "WAIT";
  let projectedTarget = null;
  let stopLoss = null;
  let targetLow = null;
  let targetHigh = null;
  let optionSuggestion = null;

  const tknStr = String(market?.token||"");
  const nm = String(market?.name||"").toUpperCase();
  const ex = String(market?.exchange||"").toUpperCase();
  const isIndex = (ex==="NSE" && Array.isArray(NSE_INDICES) && NSE_INDICES.includes(tknStr) && (nm.includes("NIFTY") || nm.includes("VIX")));

  if(signal==="BUY"){
    trade = isIndex ? "BUY CE (Index)" : `BUY ${market.name}`;
    projectedTarget = ltp ? +(ltp*(1+tgtPct)).toFixed(2) : null;
    stopLoss = ltp ? +(ltp*(1-slPct)).toFixed(2) : null;
    targetLow = ltp ? +(ltp*(1+(tgtPct*0.8))).toFixed(2) : null;
    targetHigh = ltp ? +(ltp*(1+(tgtPct*1.6))).toFixed(2) : null;
    optionSuggestion = suggestOption(market?.name, ltp, "BUY", isIndex);
  }else if(signal==="SELL"){
    trade = isIndex ? "BUY PE (Index)" : `SELL ${market.name}`;
    projectedTarget = ltp ? +(ltp*(1-tgtPct)).toFixed(2) : null;
    stopLoss = ltp ? +(ltp*(1+slPct)).toFixed(2) : null;
    targetLow = ltp ? +(ltp*(1-(tgtPct*1.6))).toFixed(2) : null;
    targetHigh = ltp ? +(ltp*(1-(tgtPct*0.8))).toFixed(2) : null;
    optionSuggestion = suggestOption(market?.name, ltp, "SELL", isIndex);
  }else{
    trade = "WAIT";
    // For HOLD, don't show misleading Target/SL equal to LTP
    projectedTarget = null;
    stopLoss = null;
    targetLow = null;
    targetHigh = null;
    optionSuggestion = null;
  }

  return {
    ...engine,
    signal,
    stabilizing: buf.stabilizing,
    trade,
    projectedTarget,
    targetLow,
    targetHigh,
    stopLoss,
    optionSuggestion,
    reason: engine?.reason || engine?.warning || ""
  };
}


// =============================================
// FETCH QUOTES
// =============================================
async function fetchQuotes(token, exchange, tokens) {

  const res = await requestAngel(
    "/rest/secure/angelbroking/market/v1/quote/",
    "POST",
    {
      ...getHeaders(token),
      "Content-Type":"application/json",
      "Accept":"application/json",
      "X-UserType":"USER",
      "X-SourceID":"WEB",
      "X-ClientLocalIP":"127.0.0.1",
      "X-ClientPublicIP":"127.0.0.1",
      "X-MACAddress":"00:00:00:00:00:00"
    },
    {
      mode:"FULL",
      exchangeTokens: {
        [exchange]: tokens
      }
    }
  );

  const fetched = res?.body?.data?.fetched || [];
  if (Array.isArray(fetched) && fetched.length) cacheQuotes(fetched, exchange);

  return fetched;
}

// =============================================
// API ROUTE
// =============================================

// =============================================
// DYNAMIC SCRIP MASTER (cached in-memory + disk)
// =============================================
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const SCRIP_CACHE_PATH = path.join(DATA_DIR, "scripMaster.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
// =============================================
// QUOTE CACHE (last known prices) - helps when market closed / MCX feed missing
// =============================================
const QUOTE_CACHE_PATH = path.join(DATA_DIR, "lastQuotes.json");
let QUOTE_CACHE = { updatedAt: 0, byToken: {} };

try {
  if (fs.existsSync(QUOTE_CACHE_PATH)) {
    QUOTE_CACHE = JSON.parse(fs.readFileSync(QUOTE_CACHE_PATH, "utf8"));
    if (!QUOTE_CACHE || typeof QUOTE_CACHE !== "object") QUOTE_CACHE = { updatedAt: 0, byToken: {} };
    if (!QUOTE_CACHE.byToken) QUOTE_CACHE.byToken = {};
  }
} catch (e) {
  QUOTE_CACHE = { updatedAt: 0, byToken: {} };
}

function cacheQuotes(fetchedList, exchange) {
  const now = Date.now();
  QUOTE_CACHE.updatedAt = now;
  if (!QUOTE_CACHE.byToken) QUOTE_CACHE.byToken = {};

  for (const item of (fetchedList || [])) {
    const token = String(item?.symbolToken || item?.token || item?.symboltoken || "");
    if (!token) continue;
    const ltp = Number(item?.ltp ?? item?.lastTradedPrice ?? item?.netPrice ?? item?.last_price ?? item?.close ?? 0);
    QUOTE_CACHE.byToken[token] = {
      exchange,
      name: item?.tradingSymbol || item?.tradingsymbol || item?.symbol || item?.name || null,
      ltp: Number.isFinite(ltp) ? ltp : null,
      raw: item,
      ts: now
    };
  }

  try {
    fs.writeFileSync(QUOTE_CACHE_PATH, JSON.stringify(QUOTE_CACHE, null, 2));
  } catch (e) {}
}

function getCachedToken(token) {
  return QUOTE_CACHE?.byToken?.[String(token)] || null;
}


let SCRIP_MASTER = { updatedAt: 0, rows: [] };

async function fetchScripMaster(force=false){
  const now = Date.now();
  const maxAgeMs = 6 * 60 * 60 * 1000; // 6h
  const stale = !SCRIP_MASTER.updatedAt || (now - SCRIP_MASTER.updatedAt > maxAgeMs);

  if(!force && !stale && Array.isArray(SCRIP_MASTER.rows) && SCRIP_MASTER.rows.length) return SCRIP_MASTER;

  // disk cache
  try{
    if(fs.existsSync(SCRIP_CACHE_PATH)){
      const disk = JSON.parse(fs.readFileSync(SCRIP_CACHE_PATH,"utf8"));
      if(disk?.updatedAt && Array.isArray(disk.rows) && disk.rows.length){
        const diskStale = (now - disk.updatedAt > maxAgeMs);
        if(!force && !diskStale){
          SCRIP_MASTER = disk;
          return SCRIP_MASTER;
        }
      }
    }
  }catch(e){}

  const url = new URL("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json");

  const raw = await new Promise((resolve,reject)=>{
    const req = https.request(
      { hostname:url.hostname, path:url.pathname+url.search, method:"GET", timeout:20000 },
      res=>{
        let data="";
        res.on("data",c=>data+=c);
        res.on("end",()=>{
          if(res.statusCode>=200 && res.statusCode<300) return resolve(data);
          reject(new Error("ScripMaster HTTP "+res.statusCode));
        });
      }
    );
    req.on("timeout",()=>req.destroy(new Error("ScripMaster timeout")));
    req.on("error",reject);
    req.end();
  });

  let rows=[];
  try{ rows = JSON.parse(raw); if(!Array.isArray(rows)) rows=[]; }catch(e){ rows=[]; }

  SCRIP_MASTER = { updatedAt: now, rows };
  try{ fs.writeFileSync(SCRIP_CACHE_PATH, JSON.stringify(SCRIP_MASTER,null,2)); }catch(e){}
  return SCRIP_MASTER;
}

function getSymbolToken(symbol, exch="NSE"){
  if(!symbol) return null;
  const sym = String(symbol).trim().toUpperCase();
  const seg = String(exch).trim().toUpperCase();
  const hit = (SCRIP_MASTER.rows||[]).find(r=>{
    const rSym = String(r.symbol||r.tradingsymbol||"").toUpperCase();
    const rSeg = String(r.exch_seg||r.exchange||"").toUpperCase();
    return rSeg===seg && rSym===sym;
  });
  if(!hit) return null;
  return { token: String(hit.token||""), row: hit };
}

function searchScrip(q, exch="", limit=20){
  const query = String(q||"").trim().toUpperCase();
  const seg = String(exch||"").trim().toUpperCase();
  const lim = Math.min(Math.max(parseInt(limit||20,10)||20,1),50);
  if(query.length<2) return [];
  const out = [];
  for(const r of (SCRIP_MASTER.rows||[])){
    const rSym = String(r.symbol||r.tradingsymbol||"").toUpperCase();
    if(!rSym) continue;
    if(seg){
      const rSeg = String(r.exch_seg||r.exchange||"").toUpperCase();
      if(rSeg!==seg) continue;
    }
    if(rSym.includes(query)){
      out.push({
        symbol: r.symbol||r.tradingsymbol||null,
        token: String(r.token||""),
        exch: r.exch_seg||r.exchange||null,
        name: r.name||r.symbolname||r.SymbolName||null,
        instrumenttype: r.instrumenttype||r.instrument_type||null,
        lotsize: r.lotsize||r.lot_size||null,
        expiry: r.expiry||null,
        strike: r.strike||null
      });
      if(out.length>=lim) break;
    }
  }
  return out;
}


// =============================================
// Market Regime (lightweight): TRENDING vs SIDEWAYS
// - Uses slope of EMA and average true range %
// =============================================
function getMarketRegime(candles){
  if(!Array.isArray(candles) || candles.length < 25) return "COLLECTING";
  const closes = candles.map(x=>x.c);
  const e5  = ema(closes.slice(-20), 5);
  const e20 = ema(closes, 20);
  if(e5==null || e20==null) return "COLLECTING";

  // ATR% approx
  let trs = [];
  for(let i=1;i<candles.length;i++){
    const prevClose = candles[i-1].c;
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - prevClose),
      Math.abs(candles[i].l - prevClose)
    );
    trs.push(tr);
  }
  const last14 = trs.slice(-14);
  const atr = last14.reduce((a,b)=>a+b,0) / Math.max(1,last14.length);
  const atrPct = (atr / closes[closes.length-1]) * 100;

  const slope = (e5 - e20) / e20 * 100; // %
  if(Math.abs(slope) > 0.08 && atrPct > 0.15) return "TRENDING";
  return "SIDEWAYS";
}

// =============================================
// INDEX ONLY: VWAP + EMA + anti-whipsaw
// =============================================
function ema(values, period){
  if(!Array.isArray(values) || values.length<period) return null;
  const k = 2/(period+1);
  let e = values[0];
  for(let i=1;i<values.length;i++) e = values[i]*k + e*(1-k);
  return e;
}

async function fetchCandleData(token, exchange, symbolToken, interval, fromdate, todate){
  const payload = { exchange, symboltoken: String(symbolToken), interval, fromdate, todate };

  const raw = await requestAngel(
    "/rest/secure/angelbroking/historical/v1/getCandleData",
    "POST",
    {
      ...getHeaders(token),
      "Content-Type":"application/json",
      "Accept":"application/json",
      "X-UserType":"USER",
      "X-SourceID":"WEB",
      "X-ClientLocalIP":"127.0.0.1",
      "X-ClientPublicIP":"127.0.0.1",
      "X-MACAddress":"00:00:00:00:00:00"
    },
    payload
  );

  const data = raw?.body?.data;
  if(!Array.isArray(data)) return [];
  return data.map(c=>({ t:c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] }));
}

function vwap(candles){
  let pv=0, vol=0;
  for(const x of candles){
    const tp = (x.h+x.l+x.c)/3;
    pv += tp*(x.v||0);
    vol += (x.v||0);
  }
  return vol>0 ? (pv/vol) : null;
}

function antiWhipsawIndexSignal(candles, fast=9, slow=21){
  if(!Array.isArray(candles) || candles.length<Math.max(slow+5,30)){
    return { signal:"HOLD", reason:"Not enough candles" };
  }
  const closes = candles.map(x=>x.c);
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const vw = vwap(candles);
  if(ef==null || es==null || vw==null) return { signal:"HOLD", reason:"Indicator not ready" };

  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  const minDist = 0.0005; // 0.05%
  const dist = Math.abs(last.c - vw)/vw;
  if(dist < minDist) return { signal:"HOLD", reason:"Too close to VWAP (chop)", emaFast:ef, emaSlow:es, vwap:vw };

  // 2-candle confirmation + trend alignment
  if(ef>es && last.c>vw && prev.c>vw && last.c>es){
    return { signal:"BUY", reason:"INDEX VWAP+EMA aligned", emaFast:ef, emaSlow:es, vwap:vw };
  }
  if(ef<es && last.c<vw && prev.c<vw && last.c<es){
    return { signal:"SELL", reason:"INDEX VWAP+EMA aligned", emaFast:ef, emaSlow:es, vwap:vw };
  }
  return { signal:"HOLD", reason:"No alignment (INDEX)", emaFast:ef, emaSlow:es, vwap:vw };
}

// =============================================
// SIMPLE in-memory session for logout + optional status
// =============================================
let SESSION = { token:null, updatedAt:0 };

// =============================================
// OPTIONAL SCRIP ROUTES (no impact on existing /api/angel contract)
// =============================================
app.get("/api/scrip/find", async(req,res)=>{
  try{
    const symbol = String(req.query.symbol||"").trim();
    const exch = String(req.query.exch||"NSE").trim().toUpperCase();
    if(!symbol) return res.status(400).json({success:false,error:"symbol is required"});
    await fetchScripMaster(false);
    const hit = getSymbolToken(symbol, exch);
    if(!hit) return res.json({success:true,found:false,symbol:symbol.toUpperCase(),exch});
    const r = hit.row;
    return res.json({
      success:true, found:true,
      symbol: String(symbol).toUpperCase(),
      exch,
      token: hit.token,
      meta:{
        name: r.name||r.symbolname||r.SymbolName||null,
        instrumenttype: r.instrumenttype||r.instrument_type||null,
        lotsize: r.lotsize||r.lot_size||null,
        expiry: r.expiry||null,
        strike: r.strike||null
      }
    });
  }catch(e){
    res.status(500).json({success:false,error:e.message});
  }
});

app.get("/api/scrip/search", async(req,res)=>{
  try{
    const q = String(req.query.q||"").trim();
    const exch = String(req.query.exch||"").trim();
    const limit = req.query.limit;
    await fetchScripMaster(false);
    const results = searchScrip(q, exch, limit);
    return res.json({success:true,q,exch:exch||null,count:results.length,results});
  }catch(e){
    res.status(500).json({success:false,error:e.message});
  }
});

app.get("/api/session/status",(req,res)=>{
  res.json({success:true, loggedIn:!!SESSION.token, updatedAt: SESSION.updatedAt || null});
});
app.post("/api/angel", async(req,res)=>{

  const {action, mpin, totp, token} = req.body;

  try{

    if(action==="login"){

      // IMPORTANT: Angel can return empty/non-JSON on failure; requestAngel now returns {statusCode, body}
      const login = await requestAngel(
        "/rest/auth/angelbroking/user/v1/loginByPassword",
        "POST",
        {
          "X-PrivateKey": CONFIG.apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-SourceID": "WEB",
          "X-UserType": "USER",
          "X-ClientLocalIP": "127.0.0.1",
          "X-ClientPublicIP": "127.0.0.1",
          "X-MACAddress": "00:00:00:00:00:00"
        },
        {
          clientcode: CONFIG.clientId,
          password: mpin,
          totp
        }
      );

      const jwt = login?.body?.data?.jwtToken;

      if(!jwt){
        return res.status(401).json({
          success:false,
          error:"Angel login failed",
          httpStatus: login?.statusCode || null,
          details: login?.body || null
        });
      }

      SESSION.token = jwt;
      SESSION.updatedAt = Date.now();

      sendTelegramAlert(`✅ Login OK\nClient: ${CONFIG.clientId || ''}`);

      return res.json({ success:true, token: jwt });
    }

    if(action==="logout"){

      // Best-effort logout: clear server session (broker token invalidation is not required for your UI)
      SESSION.token = null;
      SESSION.updatedAt = 0;
      return res.json({success:true,message:"Logged out"});
    }

    if(action==="fetch_all"){

      if(typeof resolveMctxTokens==='function') resolveMctxTokens().catch(()=>{});


      const [indRaw, comRaw, stkRaw] = await Promise.all([
        fetchQuotes(token,"NSE",NSE_INDICES),
        fetchQuotes(token,"MCX",COMMODITIES),
        fetchQuotes(token,"NSE",STOCKS)
      ]);

      // INDICES: VWAP + EMA + anti-whipsaw (INDEX ONLY)
      const indices = await Promise.all(indRaw.map(async x=>{
        const d = buildMarketData(x,"NSE");
        try{
          // last ~2 hours, 5-min candles
          const now = new Date();
          const todate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
          const from = new Date(now.getTime() - 2*60*60*1000);
          const fromdate = `${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,"0")}-${String(from.getDate()).padStart(2,"0")} ${String(from.getHours()).padStart(2,"0")}:${String(from.getMinutes()).padStart(2,"0")}`;

          const candles = await fetchCandleData(token,"NSE",d.token, "FIVE_MINUTE", fromdate, todate);
          const sig = candles.length ? antiWhipsawIndexSignal(candles,9,21) : { signal:"HOLD", reason:"No candles" };

          const regime = getMarketRegime(candles);
          // Monte Carlo edge (cached) - indices only
          const mc = await getMonteCarloCached(token, "NSE", d.token, "FIFTEEN_MINUTE", 20, 1000);
          const edge = classifyEdge(mc?.stats?.winUp0_5);



          // Keep your UI engine fields (mode/trade/targets) by adapting
          const engine = {
            ...signalEngine(d,false),
            signal: sig.signal,
            mode: (sig.signal==="BUY") ? "MODE1" : (sig.signal==="SELL") ? "MODE2" : "MODE1",
            reason: sig.reason,
            vwap: sig.vwap ?? null,
            emaFast: sig.emaFast ?? null,
            emaSlow: sig.emaSlow ?? null,
            regime,
            mc, // {S0, params, stats}
            edge: edge.badge
          };

          // Decision overlay: downgrade low-edge BUY/SELL to HOLD in sideways regimes
          if(engine.signal==="BUY"){
            if((mc?.stats?.winUp0_5 ?? 0) < 50) engine.signal="HOLD";
            else if((mc?.stats?.winUp0_5 ?? 0) < 60 && regime!=="TRENDING") engine.signal="HOLD";
          }
          if(engine.signal==="SELL"){
            // use downside probability when available
            if((mc?.stats?.winDown0_5 ?? 0) < 50) engine.signal="HOLD";
            else if((mc?.stats?.winDown0_5 ?? 0) < 60 && regime!=="TRENDING") engine.signal="HOLD";
          }

          // Provide statistically expected targets when MC present
          if(mc?.stats){
            engine.expected = { p10: mc.stats.p10, p50: mc.stats.p50, p90: mc.stats.p90 };
            if(engine.signal==="BUY"){
              engine.projectedTarget = `${mc.stats.p50} - ${mc.stats.p90}`;
              engine.stopLoss = mc.stats.p10;
            }else if(engine.signal==="SELL"){
              engine.projectedTarget = `${mc.stats.p50} - ${mc.stats.p10}`;
              engine.stopLoss = mc.stats.p90;
            }else{
              engine.projectedTarget = mc.stats.p50;
              engine.stopLoss = mc.stats.p10;
            }
          }
          return { ...d, engine: enrichEngine(d, engine) };
        }catch(e){
          // fallback to old engine on any failure
          return { ...d, engine: enrichEngine(d, signalEngine(d,false)), candleError: e.message };
        }
      }));const commodities = (comRaw && comRaw.length ? comRaw : [])
        .map(x=>{
          const d=buildMarketData(x,"MCX");
          return {...d, engine: enrichEngine(d, signalEngine(d,true))};
        });

      // If MCX feed not available, fall back to cached last prices for your configured tokens
      if(!commodities.length){
        const cached = COM_TOKENS.map(t=>{
          const c = getCachedToken(t);
          if(!c) return null;
          const d = { name: c.name || ("MCX-"+t), token: t, exchange:"MCX", ltp: c.ltp, ts: c.ts, cached:true };
          return { ...d, engine: enrichEngine(d, { signal:"HOLD", mode:"MODE1", warning:"CACHED" }) };
        }).filter(Boolean);
        commodities.push(...cached);
      }
const stocks = stkRaw.map(x=>{
        const d=buildMarketData(x,"NSE");
        return {...d, engine: enrichEngine(d, signalEngine(d,false))};
      });

      return res.json({
        success:true,
        data:{indices,commodities,stocks}
      });
    }

    res.json({success:false,error:"Invalid action"});

  }catch(e){
    console.error("ENGINE ERROR:",e);
    res.status(500).json({success:false,error:e.message});
  }

});

// =============================================

// Debug endpoint: resolved MCX tokens
app.get("/api/mcx/resolved",(req,res)=>{
  res.json({ success:true, resolved: RESOLVED_MCX });
});

// Live MCX LTP endpoint (useful for quick diagnostics)
app.get("/api/mcx/ltp", async (req,res)=>{
  try{
    const auth = String(req.headers.authorization || "");
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const token = bearer || String(req.query.token || "") || SESSION.token;

    if(!token){
      return res.status(401).json({ success:false, error:"Not logged in (missing token). Send Authorization: Bearer <token>." });
    }

    const raw = await fetchQuotes(token,"MCX",COM_TOKENS);
    const commodities = (raw && raw.length ? raw : []).map(x=>{
      const d = buildMarketData(x,"MCX");
      return { ...d, engine: enrichEngine(d, signalEngine(d,true)) };
    });

    // keep cache warm + expose resolved mapping for front-end
    if(typeof resolveMctxTokens==='function') resolveMctxTokens().catch(()=>{});

    return res.json({ success:true, data:{ commodities }, resolved: RESOLVED_MCX });
  }catch(e){
    console.error("MCX LTP ERROR:", e);
    return res.status(500).json({ success:false, error:e.message });
  }
});




// =============================================
// Monte Carlo helpers + cache
// - Cache per (exchange:token:interval:days:paths) for 5 minutes to avoid heavy compute
// - Computes BOTH upside and downside win probabilities for +/-0.5%
// =============================================
const MC_CACHE = {}; // key -> { ts, payload }
const MC_TTL_MS = 5 * 60 * 1000;

function mcKey({exchange, token, interval, days, paths}){
  return `${exchange}:${token}:${interval}:${days}:${paths}`;
}

function computeMCFromCloses(closes, days, paths){
  // log returns
  const rets = [];
  for(let i=1;i<closes.length;i++){
    const r = Math.log(closes[i]/closes[i-1]);
    if(Number.isFinite(r)) rets.push(r);
  }
  if(rets.length < 20) return { ok:false, error:"Not enough returns" };

  const mu = rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd = Math.sqrt(rets.reduce((a,b)=>a+(b-mu)*(b-mu),0)/Math.max(1,rets.length-1));

  const S0 = closes[closes.length-1];
  const nSteps = Math.max(5, parseInt(days,10) || 20);
  const nPaths = Math.min(3000, Math.max(300, parseInt(paths,10) || 1000));

  const upThr = S0 * 1.005;
  const dnThr = S0 * 0.995;

  let winsUp = 0, winsDn = 0;
  let finals = [];

  for(let p=0;p<nPaths;p++){
    let S = S0;
    for(let k=0;k<nSteps;k++){
      // Box-Muller
      const u1 = Math.random() || 1e-9;
      const u2 = Math.random() || 1e-9;
      const z = Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2);
      S = S * Math.exp((mu - 0.5*sd*sd) + sd*z);
    }
    finals.push(S);
    if(S >= upThr) winsUp++;
    if(S <= dnThr) winsDn++;
  }

  finals.sort((a,b)=>a-b);
  const pct = (q)=> finals[Math.floor(q*(finals.length-1))] || finals[0];

  return {
    ok:true,
    S0,
    mu, sigma: sd,
    params: { days:nSteps, paths:nPaths },
    stats: {
      winUp0_5: +(winsUp/nPaths*100).toFixed(2),
      winDown0_5: +(winsDn/nPaths*100).toFixed(2),
      p10: +pct(0.10).toFixed(2),
      p50: +pct(0.50).toFixed(2),
      p90: +pct(0.90).toFixed(2),
      mu: +mu.toFixed(6),
      sigma: +sd.toFixed(6)
    }
  };
}

async function getMonteCarloCached(jwtToken, exchange, token, interval="FIFTEEN_MINUTE", days=20, paths=1000){
  const key = mcKey({exchange, token, interval, days, paths});
  const now = Date.now();
  const hit = MC_CACHE[key];
  if(hit && (now - hit.ts) < MC_TTL_MS) return hit.payload;

  // Pull ~14 days of candles to estimate distribution
  const nowD = new Date();
  const todate = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,"0")}-${String(nowD.getDate()).padStart(2,"0")} ${String(nowD.getHours()).padStart(2,"0")}:${String(nowD.getMinutes()).padStart(2,"0")}`;
  const from = new Date(nowD.getTime() - 14*24*60*60*1000);
  const fromdate = `${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,"0")}-${String(from.getDate()).padStart(2,"0")} 09:15`;

  const candles = await fetchCandleData(jwtToken, exchange, token, interval, fromdate, todate);
  const closes = candles.map(c=>c.c).filter(x=>Number.isFinite(x));
  if(closes.length < 30) return null;

  const out = computeMCFromCloses(closes, days, paths);
  if(!out.ok) return null;

  const payload = {
    exchange, token, interval,
    S0: out.S0,
    params: out.params,
    stats: out.stats
  };

  MC_CACHE[key] = { ts: now, payload };
  return payload;
}

function classifyEdge(winProb){
  if(winProb == null) return { badge:"NA", color:"gray" };
  if(winProb >= 60) return { badge:"POSITIVE", color:"green" };
  if(winProb >= 50) return { badge:"NEUTRAL", color:"amber" };
  return { badge:"NEGATIVE", color:"red" };
}

// =============================================
// Monte Carlo Simulation (Backtesting)
// Endpoint: POST /api/backtest/montecarlo
// Body: { token, exchange, jwtToken, days, paths, interval }
// Uses Angel candle API to estimate drift/vol and simulates price paths.
// =============================================
app.post("/api/backtest/montecarlo", async(req,res)=>{
  try{
    const { token: symbolToken, exchange="NSE", jwtToken, days=20, paths=1000, interval="FIFTEEN_MINUTE" } = req.body || {};
    const t = String(symbolToken||"").trim();
    if(!t) return res.status(400).json({ success:false, error:"token is required" });
    if(!jwtToken) return res.status(400).json({ success:false, error:"jwtToken is required" });

    // Pull candles
    const now = new Date();
    const todate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    const from = new Date(now.getTime() - 14*24*60*60*1000);
    const fromdate = `${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,"0")}-${String(from.getDate()).padStart(2,"0")} 09:15`;

    const candles = await fetchCandleData(jwtToken, exchange, t, interval, fromdate, todate);
    if(!candles.length) return res.json({ success:false, error:"No candle data", details:{ exchange, token:t, interval } });

    const closes = candles.map(c=>c.c).filter(x=>Number.isFinite(x));
    if(closes.length < 30) return res.json({ success:false, error:"Not enough candle closes" });

    const out = computeMCFromCloses(closes, days, paths);
    if(!out.ok) return res.json({ success:false, error: out.error });

    return res.json({
      success:true,
      exchange,
      token: t,
      interval,
      S0: out.S0,
      params: out.params,
      stats: {
        winUp0_5: out.stats.winUp0_5,
        winDown0_5: out.stats.winDown0_5,
        p10: out.stats.p10,
        p50: out.stats.p50,
        p90: out.stats.p90,
        mu: out.stats.mu,
        sigma: out.stats.sigma
      }
    });
  }catch(e){
    res.status(500).json({ success:false, error:e.message });
  }
});


app.get("/api/status",(req,res)=>{
  res.json({
    success:true,
    service:"Trade Genie",
    version:"server.edge.v3",
    time: new Date().toISOString(),
    loggedIn: !!SESSION?.token,
    mcxResolved: (typeof RESOLVED_MCX!=="undefined") ? RESOLVED_MCX : null,
    features:{ mcx:true, monteCarloEdge:true, optionSuggestions:true }
  });
});


// Greeks endpoint (manual inputs)
// POST /api/options/greeks
// Body: { S, K, T_days, r, sigma, type:"CE"|"PE" }
app.post("/api/options/greeks",(req,res)=>{
  try{
    const { S, K, T_days, r, sigma, type } = req.body || {};
    const T = Number(T_days)/365;
    const out = Greeks.compute({ S, K, T, r, sigma, type });
    if(!out.ok) return res.status(400).json({ success:false, error: out.error });
    res.json({ success:true, greeks: out });
  }catch(e){
    res.status(500).json({ success:false, error: e.message });
  }
});

app.listen(PORT,()=>{
  console.log("🚀 FINAL ROBUST ENGINE running on",PORT);
});
