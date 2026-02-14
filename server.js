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
// INSTRUMENTS
// =============================================
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
        try{
          resolve(JSON.parse(body));
        }catch(e){
          reject(e);
        }
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
// FETCH QUOTES
// =============================================
async function fetchQuotes(token, exchange, list){

  const res = await requestAngel(
    "/rest/secure/angelbroking/market/v1/quote/",
    "POST",
    getHeaders(token),
    { mode:"FULL", exchangeTokens:{ [exchange]:list } }
  );

  return res?.data?.fetched || [];
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

  const data = raw?.data;
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

      const login = await requestAngel(
        "/rest/auth/angelbroking/user/v1/loginByPassword",
        "POST",
        {
          "X-PrivateKey":CONFIG.apiKey,
          "Content-Type":"application/json"
        },
        {
          clientcode:CONFIG.clientId,
          password:mpin,
          totp
        }
      );

      const jwt = login?.data?.jwtToken;
      if(!jwt){
        return res.json({
          success:false,
          error:"Angel login failed",
          details: login
        });
      }

      // store token in server session too (helps logout/status)
      SESSION.token = jwt;
      SESSION.updatedAt = Date.now();

      return res.json({
        success:true,
        token: jwt
      });
    }

    if(action==="logout"){

      // Best-effort logout: clear server session (broker token invalidation is not required for your UI)
      SESSION.token = null;
      SESSION.updatedAt = 0;
      return res.json({success:true,message:"Logged out"});
    }

    if(action==="fetch_all"){

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

          const candles = await fetchCandleData(token,"NSE",d.token||d.symboltoken||d.symbolToken||d.symbolToken,d.interval||"FIVE_MINUTE" ? "FIVE_MINUTE" : "FIVE_MINUTE", fromdate, todate);
          const sig = candles.length ? antiWhipsawIndexSignal(candles,9,21) : { signal:"HOLD", reason:"No candles" };

          // Keep your UI engine fields (mode/trade/targets) by adapting
          const engine = {
            ...signalEngine(d,false),
            signal: sig.signal,
            mode: (sig.signal==="BUY") ? "MODE1" : (sig.signal==="SELL") ? "MODE2" : "MODE1",
            reason: sig.reason,
            vwap: sig.vwap ?? null,
            emaFast: sig.emaFast ?? null,
            emaSlow: sig.emaSlow ?? null
          };
          return { ...d, engine };
        }catch(e){
          // fallback to old engine on any failure
          return { ...d, engine: signalEngine(d,false), candleError: e.message };
        }
      }));const commodities = comRaw.map(x=>{
        const d=buildMarketData(x,"MCX");
        return {...d, engine:signalEngine(d,true)};
      });

      const stocks = stkRaw.map(x=>{
        const d=buildMarketData(x,"NSE");
        return {...d, engine:signalEngine(d,false)};
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
app.listen(PORT,()=>{
  console.log("🚀 FINAL ROBUST ENGINE running on",PORT);
});
