const express=require("express");
const cors=require("cors");
const https=require("https");

const app=express();
app.use(cors());
app.use(express.json());

const PORT=process.env.PORT||3000;

const CONFIG={
 apiKey:process.env.ANGEL_API_KEY||"JkFNQiMO",
 clientId:process.env.ANGEL_CLIENT_ID||"V58776779",
 baseURL:"apiconnect.angelone.in"
};

const NSE_INDICES=["99926000","99926009","99926037","99926017"];
const COMMODITIES=["257681","254721","258847","259304"];
const STOCKS=["3045","11536","1333","1594","4963","1660","3787"];

let CACHE={indices:[],commodities:[],stocks:[]};

function reqAngel(path,method,headers,data){
 return new Promise((resolve,reject)=>{
  const req=https.request({hostname:CONFIG.baseURL,path,method,headers},res=>{
   let body="";
   res.on("data",c=>body+=c);
   res.on("end",()=>resolve(JSON.parse(body||"{}")));
  });
  if(data)req.write(JSON.stringify(data));
  req.on("error",reject);
  req.end();
 });
}

function headers(token){
 return{
  Authorization:`Bearer ${token}`,
  "Content-Type":"application/json",
  "X-PrivateKey":CONFIG.apiKey,
  "X-SourceID":"WEB",
  "X-UserType":"USER",
  "X-ClientLocalIP":"127.0.0.1",
  "X-ClientPublicIP":"127.0.0.1",
  "X-MACAddress":"00:00:00:00:00:00"
 };
}

function build(item,ex){
 const ltp=parseFloat(item.ltp||0);
 const close=parseFloat(item.close||ltp);
 const high=parseFloat(item.high||ltp);
 const low=parseFloat(item.low||ltp);

 return{
  name:item.tradingSymbol||"Unknown",
  token:item.symbolToken,
  exchange:ex,
  ltp,
  high,low,close,
  range:high-low,
  changePct:close?((ltp-close)/close)*100:0
 };
}

function projection(i,sig){
 const move=i.range*1.5;
 if(sig==="BUY") return Math.round(i.ltp+move);
 if(sig==="SELL") return Math.round(i.ltp-move);
 return "-";
}

function engine(i,commodity=false){

 let sig="HOLD";
 if(i.changePct>0.6) sig="BUY";
 if(i.changePct<-0.6) sig="SELL";

 const risk=Math.min(100,Math.round(Math.abs(i.changePct)*8+(commodity?12:0)));
 const mode=risk<40?"MODE1":"MODE2";

 const strike=Math.round(i.ltp/100)*100;
 const trade=
  sig==="BUY"?`${i.name.split("-")[0]} ${strike} CE`
  :sig==="SELL"?`${i.name.split("-")[0]} ${strike} PE`
  :"-";

 return{
  signal:sig,
  mode,
  risk,
  trade,
  trend:sig==="BUY"?"Bullish":sig==="SELL"?"Bearish":"Sideways",
  projectedTarget:projection(i,sig),
  stopLoss:"30%",
  warning:risk>=40?"⚠️ Higher Risk Trade":""
 };
}

async function fetchQuotes(token,ex,list){
 const r=await reqAngel(
  "/rest/secure/angelbroking/market/v1/quote/",
  "POST",
  headers(token),
  {mode:"FULL",exchangeTokens:{[ex]:list}}
 );
 return r?.data?.fetched||[];
}

app.post("/api/angel",async(req,res)=>{

 const{action,mpin,totp,token}=req.body;

 if(action==="login"){
  const login=await reqAngel(
   "/rest/auth/angelbroking/user/v1/loginByPassword",
   "POST",
   {
    "Content-Type":"application/json",
    "X-PrivateKey":CONFIG.apiKey,
    "X-ClientLocalIP":"127.0.0.1",
    "X-ClientPublicIP":"127.0.0.1",
    "X-MACAddress":"00:00:00:00:00:00",
    "X-UserType":"USER",
    "X-SourceID":"WEB"
   },
   {clientcode:CONFIG.clientId,password:mpin,totp}
  );

  if(login?.status&&login?.data?.jwtToken)
   return res.json({success:true,token:login.data.jwtToken});

  return res.json({success:false});
 }

 if(action==="fetch_all"){

  const[i,c,s]=await Promise.all([
   fetchQuotes(token,"NSE",NSE_INDICES),
   fetchQuotes(token,"MCX",COMMODITIES),
   fetchQuotes(token,"NSE",STOCKS)
  ]);

  if(i.length) CACHE.indices=i.map(x=>{
   const d=build(x,"NSE");
   return {...d,engine:engine(d,false)};
  });

  if(c.length) CACHE.commodities=c.map(x=>{
   const d=build(x,"MCX");
   return {...d,engine:engine(d,true)};
  });

  if(s.length) CACHE.stocks=s.map(x=>{
   const d=build(x,"NSE");
   return {...d,engine:engine(d,false)};
  });

  return res.json({success:true,data:CACHE});
 }

 res.json({success:false});
});

app.listen(PORT,()=>console.log("FINAL PRO ENGINE RUNNING",PORT));
