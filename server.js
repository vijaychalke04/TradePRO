const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY || "JkFNQiMO",
  clientId: process.env.ANGEL_CLIENT_ID || "V58776779",
  baseURL: "apiconnect.angelone.in"
};

const NSE_INDICES = ['99926000','99926009','99926037','99926017'];
const COMMODITIES = ['257681','254721','258847','259304'];
const STOCKS = ['3045','11536','1333','1594','4963','1660','3787'];

function requestAngel(path, method, headers, data){
  return new Promise((resolve,reject)=>{
    const req = https.request(
      {hostname:CONFIG.baseURL,path,method,headers},
      res=>{
        let body="";
        res.on("data",c=>body+=c);
        res.on("end",()=>{
          try{resolve(JSON.parse(body));}
          catch(e){reject(e);}
        });
      }
    );
    if(data) req.write(JSON.stringify(data));
    req.on("error",reject);
    req.end();
  });
}

function headers(token){
  return {
    Authorization:`Bearer ${token}`,
    "X-PrivateKey":CONFIG.apiKey,
    "Content-Type":"application/json",
    "X-SourceID":"WEB",
    "X-UserType":"USER"
  };
}

function alpha(i){
  if(i.changePct>0.5) return "BUY";
  if(i.changePct<-0.5) return "SELL";
  return "HOLD";
}

function beta(i){
  return Math.abs(i.changePct)>0.3;
}

function risk(i,commodity=false){
  let r=Math.abs(i.changePct)*10;
  if(commodity) r+=10;
  return Math.min(100,Math.round(r));
}

function signalEngine(i,commodity=false){
  const a=alpha(i);
  const b=beta(i);
  const r=risk(i,commodity);
  const mode=r<40?"MODE1":"MODE2";

  if(a==="HOLD") return {signal:"HOLD",risk:r,mode};

  return {
    signal:b?a:"HOLD",
    risk:r,
    mode,
    warning:r>=40?"⚠️ Higher Risk Trade":""
  };
}

function process(item,exchange){
  const ltp=parseFloat(item.ltp||0);
  const close=parseFloat(item.close||ltp);
  return {
    name:item.tradingSymbol||"Unknown",
    token:item.symbolToken,
    exchange,
    ltp,
    open:parseFloat(item.open||ltp),
    high:parseFloat(item.high||ltp),
    low:parseFloat(item.low||ltp),
    close,
    changePct:close?((ltp-close)/close)*100:0
  };
}

async function fetchQuotes(token,exchange,list){
  const r=await requestAngel(
    "/rest/secure/angelbroking/market/v1/quote/",
    "POST",
    headers(token),
    {mode:"FULL",exchangeTokens:{[exchange]:list}}
  );
  return r?.data?.fetched||[];
}

app.post("/api/angel",async(req,res)=>{
  const {action,mpin,totp,token}=req.body;

  if(action==="login"){
    const r=await requestAngel(
      "/rest/auth/angelbroking/user/v1/loginByPassword",
      "POST",
      {"X-PrivateKey":CONFIG.apiKey,"Content-Type":"application/json"},
      {clientcode:CONFIG.clientId,password:mpin,totp}
    );
    return res.json({success:true,token:r.data.jwtToken});
  }

  if(action==="fetch_all"){
    const [i,c,s]=await Promise.all([
      fetchQuotes(token,"NSE",NSE_INDICES),
      fetchQuotes(token,"MCX",COMMODITIES),
      fetchQuotes(token,"NSE",STOCKS)
    ]);

    const indices=i.map(x=>{
      const k=process(x,"NSE");
      return {...k,engine:signalEngine(k,false)};
    });

    const commodities=c.map(x=>{
      const k=process(x,"MCX");
      return {...k,engine:signalEngine(k,true)};
    });

    const stocks=s.map(x=>{
      const k=process(x,"NSE");
      return {...k,engine:signalEngine(k,false)};
    });

    res.json({success:true,data:{indices,commodities,stocks}});
  }
});

app.listen(PORT,()=>console.log("PRO ENGINE running"));
