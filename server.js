// ============================================
// TRADE GENIE - FINAL ROBUST ENGINE
// ANGEL ONE LOGIN FIXED VERSION
// ============================================

const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================
// CONFIG
// ============================================
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "JkFNQiMO",
  clientId: process.env.ANGEL_CLIENT_ID || "V58776779",
  baseURL: "apiconnect.angelone.in"
};

// ============================================
// INSTRUMENT LIST
// ============================================

const NSE_INDICES = ["99926000","99926009","99926037","99926017"];
const COMMODITIES = ["257681","254721","258847","259304"];
const STOCKS = ["3045","11536","1333","1594","4963","1660","3787"];

// ============================================
// REQUEST HELPER
// ============================================

function angelRequest(path, method, headers, data){

  return new Promise((resolve,reject)=>{

    const req = https.request({
      hostname: CONFIG.baseURL,
      path,
      method,
      headers
    }, res=>{

      let body="";

      res.on("data", chunk => body += chunk);

      res.on("end", ()=>{
        try{
          resolve(JSON.parse(body));
        }catch(e){
          reject(e);
        }
      });

    });

    req.on("error", reject);

    if(data) req.write(JSON.stringify(data));
    req.end();
  });
}

function quoteHeaders(token){
  return {
    Authorization:`Bearer ${token}`,
    "Content-Type":"application/json",
    "X-PrivateKey": CONFIG.apiKey,
    "X-SourceID":"WEB",
    "X-UserType":"USER",
    "X-ClientLocalIP":"127.0.0.1",
    "X-ClientPublicIP":"127.0.0.1",
    "X-MACAddress":"00:00:00:00:00:00"
  };
}

// ============================================
// MARKET DATA BUILDER
// ============================================

function buildData(item, exchange){

  const ltp = parseFloat(item.ltp || 0);
  const close = parseFloat(item.close || ltp);
  const high = parseFloat(item.high || ltp);
  const low = parseFloat(item.low || ltp);

  return {
    name: item.tradingSymbol || "Unknown",
    token: item.symbolToken,
    exchange,
    ltp,
    open: parseFloat(item.open || ltp),
    high,
    low,
    close,
    range: high-low,
    changePct: close ? ((ltp-close)/close)*100 : 0
  };
}

// ============================================
// SIGNAL ENGINE
// ============================================

function alphaEngine(i){
  if(i.changePct > 0.6) return "BUY";
  if(i.changePct < -0.6) return "SELL";
  return "HOLD";
}

function betaEngine(i){
  if(i.range === 0) return false;
  const vol = (i.range / i.ltp) * 100;
  return Math.abs(i.changePct) > vol * 0.3;
}

function riskEngine(i, commodity=false){

  let risk = Math.abs(i.changePct)*8;
  risk += ((i.range / i.ltp) * 100) * 2;

  if(commodity) risk += 12;

  return Math.min(100, Math.round(risk));
}

function signalEngine(i, commodity=false){

  const alpha = alphaEngine(i);
  const beta = betaEngine(i);
  const risk = riskEngine(i, commodity);

  const mode = risk < 40 ? "MODE1" : "MODE2";

  if(alpha==="HOLD"){
    return {signal:"HOLD",mode,risk};
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
    warning:risk>=40 ? "⚠️ Higher Risk Trade" : ""
  };
}

// ============================================
// FETCH QUOTES
// ============================================

async function fetchQuotes(token, exchange, tokens){

  const result = await angelRequest(
    "/rest/secure/angelbroking/market/v1/quote/",
    "POST",
    quoteHeaders(token),
    { mode:"FULL", exchangeTokens:{[exchange]:tokens} }
  );

  return result?.data?.fetched || [];
}

// ============================================
// MAIN API
// ============================================

app.post("/api/angel", async(req,res)=>{

  const {action, mpin, totp, token} = req.body;

  try{

    // ========= LOGIN =========
    if(action==="login"){

      const loginResult = await angelRequest(
        "/rest/auth/angelbroking/user/v1/loginByPassword",
        "POST",
        {
          "Content-Type":"application/json",
          "X-PrivateKey": CONFIG.apiKey,
          "X-ClientLocalIP":"127.0.0.1",
          "X-ClientPublicIP":"127.0.0.1",
          "X-MACAddress":"00:00:00:00:00:00",
          "X-UserType":"USER",
          "X-SourceID":"WEB"
        },
        {
          clientcode: CONFIG.clientId,
          password: mpin,
          totp: totp
        }
      );

      console.log("LOGIN RESPONSE:", loginResult);

      if(loginResult?.status && loginResult?.data?.jwtToken){
        return res.json({
          success:true,
          token: loginResult.data.jwtToken
        });
      }

      return res.json({
        success:false,
        error: loginResult?.message || "Login failed"
      });
    }

    // ========= FETCH DATA =========
    if(action==="fetch_all"){

      const [indRaw, comRaw, stkRaw] = await Promise.all([
        fetchQuotes(token,"NSE",NSE_INDICES),
        fetchQuotes(token,"MCX",COMMODITIES),
        fetchQuotes(token,"NSE",STOCKS)
      ]);

      const indices = indRaw.map(x=>{
        const d = buildData(x,"NSE");
        return {...d, engine:signalEngine(d,false)};
      });

      const commodities = comRaw.map(x=>{
        const d = buildData(x,"MCX");
        return {...d, engine:signalEngine(d,true)};
      });

      const stocks = stkRaw.map(x=>{
        const d = buildData(x,"NSE");
        return {...d, engine:signalEngine(d,false)};
      });

      return res.json({
        success:true,
        data:{indices,commodities,stocks}
      });
    }

    res.json({success:false,error:"Invalid action"});

  }catch(e){
    console.error("SERVER ERROR:",e);
    res.status(500).json({success:false,error:e.message});
  }

});

// ============================================

app.listen(PORT,()=>{
  console.log("🚀 FINAL ENGINE RUNNING ON PORT",PORT);
});
