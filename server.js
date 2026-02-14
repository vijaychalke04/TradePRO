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

function requestAngel(path,method,headers,data){
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
  "X-PrivateKey":CONFIG.apiKey,
  "Content-Type":"application/json",
  "X-SourceID":"WEB",
  "X-UserType":"USER",
  "X-ClientLocalIP":"127.0.0.1",
  "X-ClientPublicIP":"127.0.0.1",
  "X-MACAddress":"00:00:00:00:00:00"
 };
}

function build(item,exchange){
 const ltp=parseFloat(item.ltp||0);
 const close=parseFloat(item.close||ltp);
 const high=parseFloat(item.high||ltp);
 const low=parseFloat(item.low||ltp);

 return{
  name:item.tradingSymbol||"Unknown",
  token:item.symbolToken,
  exchange,
  ltp,open:parseFloat(item.open||ltp),
  high,low,close,
  range:high-low,
  changePct:close?((ltp-close)/close)*100:0
 };
}

function alpha(i){
 if(i.changePct>0.6)return"BUY";
 if(i.changePct<-0.6)return"SELL";
 return"HOLD";
}

function beta(i){
 if(i.range===0)return false;
 return Math.abs(i.changePct)>0.3;
}

function risk(i,commodity=false){
 let r=Math.abs(i.changePct)*8;
 if(commodity)r+=12;
 return Math.min(100,Math.round(r));
}

function optionSuggestion(i,signal){
 let strike=Math.round(i.ltp/100)*100;

 if(signal==="BUY"){
   return `${i.name.split("-")[0]} ${strike} CE`;
 }
 if(signal==="SELL"){
   return `${i.name.split("-")[0]} ${strike} PE`;
 }
 return "-";
}

function engine(i,commodity=false){

 const a=alpha(i);
 const b=beta(i);
 const r=risk(i,commodity);
 const mode=r<40?"MODE1":"MODE2";

 const signal=(a==="HOLD"||!b)?"HOLD":a;

 return{
  signal,
  mode,
  risk:r,
  warning:r>=40?"⚠️ Higher Risk Trade":"",
  trade:optionSuggestion(i,signal),
  stopLoss:"30%",
  target:"60%"
 };
}

async function fetchQuotes(token,exchange,list){
 const res=await requestAngel(
  "/rest/secure/angelbroking/market/v1/quote/",
  "POST",
  headers(token),
  {mode:"FULL",exchangeTokens:{[exchange]:list}}
 );
 return res?.data?.fetched||[];
}

app.post("/api/angel",async(req,res)=>{

 const{action,mpin,totp,token}=req.body;

 if(action==="login"){
  const login=await requestAngel(
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

  if(login?.status&&login?.data?.jwtToken){
   return res.json({success:true,token:login.data.jwtToken});
  }

  return res.json({success:false,error:"Login failed"});
 }

 if(action==="fetch_all"){

  try{

   const [i,c,s]=await Promise.all([
    fetchQuotes(token,"NSE",NSE_INDICES),
    fetchQuotes(token,"MCX",COMMODITIES),
    fetchQuotes(token,"NSE",STOCKS)
   ]);

   if(i.length){
    CACHE.indices=i.map(x=>{
      const d=build(x,"NSE");
      return {...d,engine:engine(d,false)};
    });
   }

   if(c.length){
    CACHE.commodities=c.map(x=>{
      const d=build(x,"MCX");
      return {...d,engine:engine(d,true)};
    });
   }

   if(s.length){
    CACHE.stocks=s.map(x=>{
      const d=build(x,"NSE");
      return {...d,engine:engine(d,false)};
    });
   }

   return res.json({success:true,data:CACHE});

  }catch(e){
    return res.json({success:true,data:CACHE});
  }
 }

 res.json({success:false});
});

app.listen(PORT,()=>console.log("FINAL ROBUST ENGINE RUNNING",PORT));
