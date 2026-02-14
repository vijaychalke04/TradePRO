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

      return res.json({
        success:true,
        token:login.data.jwtToken
      });
    }

    if(action==="fetch_all"){

      const [indRaw, comRaw, stkRaw] = await Promise.all([
        fetchQuotes(token,"NSE",NSE_INDICES),
        fetchQuotes(token,"MCX",COMMODITIES),
        fetchQuotes(token,"NSE",STOCKS)
      ]);

      const indices = indRaw.map(x=>{
        const d=buildMarketData(x,"NSE");
        return {...d, engine:signalEngine(d,false)};
      });

      const commodities = comRaw.map(x=>{
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
