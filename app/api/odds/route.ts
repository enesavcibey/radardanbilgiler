import { NextResponse } from "next/server";

const sports=["soccer_epl","soccer_spain_la_liga","soccer_italy_serie_a","soccer_germany_bundesliga","soccer_uefa_champs_league","basketball_nba","basketball_euroleague"];
const coreMarkets=["h2h","spreads","totals"];
const extraFootballMarkets=["h2h_h1","h2h_h2","totals_h1","totals_h2","btts","btts_h1","double_chance","double_chance_h1","halftime_fulltime"];
type Outcome={name:string;price:number;point?:number};
type Market={key:string;outcomes:Outcome[]};
type Bookmaker={title:string;markets:Market[]};
type Event={id:string;sport_key:string;sport_title:string;commence_time:string;home_team:string;away_team:string;bookmakers:Bookmaker[]};
type Quote=Outcome&{book:string;probability:number};
type Candidate={marketKey:string;selection:string;outcomeName:string;point?:number;probability:number;score:number;quotes:Quote[];low:number;high:number;fairOdd:number};
type ModelChoice=Candidate&{probability:number;statUsed:boolean};
type SportsMatch={sport:"Futbol"|"Basketbol";id:number;homeId:number;awayId:number;home:string;away:string;season?:string;startsAt:string};
type AnalysisContext={probabilities?:{home:number;draw?:number;away:number};signals:string[];warning?:string;underOver?:string;predictedTotal?:number};
type ApiResult<T>={response?:T;errors?:unknown};

const responseCaches=new Map<string,{until:number;payload:unknown}>();
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const percentNumber=(value:unknown)=>{const n=Number(String(value??"").replace("%",""));return Number.isFinite(n)?n/100:undefined};
const dateKey=(date:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul"}).format(date);
const oddsDate=(date:Date)=>date.toISOString().replace(/\.\d{3}Z$/,"Z");
const normalize=(value:string)=>value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\b(fc|cf|bc|bk|basket|club|calcio)\b/g," ").replace(/[^a-z0-9]+/g," ").trim();
const teamSimilarity=(a:string,b:string)=>{const x=normalize(a),y=normalize(b);if(!x||!y)return 0;if(x===y||x.includes(y)||y.includes(x))return 1;const aa=new Set(x.split(" ")),bb=new Set(y.split(" "));const common=[...aa].filter(v=>bb.has(v)).length;return common/Math.max(aa.size,bb.size)};
const demo=()=>NextResponse.json({demo:true,picks:[]},{headers:{"Cache-Control":"no-store"}});
const leagueName=(name:string)=>({"EPL":"İngiltere Premier Lig","Premier League":"İngiltere Premier Lig","La Liga - Spain":"İspanya La Liga","Serie A - Italy":"İtalya Serie A","Bundesliga - Germany":"Almanya Bundesliga","UEFA Champions League":"UEFA Şampiyonlar Ligi","Euroleague":"EuroLeague"}[name]??name);
const marketName=(key:string)=>({h2h:"Maç sonucu",spreads:"Handikap",totals:"Toplam gol veya sayı",h2h_h1:"İlk yarı sonucu",h2h_h2:"İkinci yarı sonucu",totals_h1:"İlk yarı toplamı",totals_h2:"İkinci yarı toplamı",btts:"Karşılıklı gol",btts_h1:"İlk yarı karşılıklı gol",double_chance:"Çifte şans",double_chance_h1:"İlk yarı çifte şans",halftime_fulltime:"İlk yarı / maç sonucu"}[key]??key);
const translateOutcome=(name:string)=>({draw:"Beraberlik",over:"Üst",under:"Alt",yes:"Evet",no:"Hayır",home:"Ev",away:"Deplasman"}[name.toLowerCase()]??name);
const selectionName=(market:string,name:string,point?:number)=>{
  if(market.startsWith("totals"))return `${point} ${name.toLowerCase()==="over"?"Üst":"Alt"}`;
  if(market.startsWith("spreads"))return `${translateOutcome(name)} ${Number(point)>0?"+":""}${point}`;
  return translateOutcome(name);
};

function candidates(event:Event):Candidate[]{
  const keys=[...new Set(event.bookmakers.flatMap(book=>book.markets.map(m=>m.key)))].filter(key=>!key.endsWith("_lay"));
  return keys.flatMap(marketKey=>{
    const grouped=new Map<string,Quote[]>();
    for(const book of event.bookmakers){
      const market=book.markets.find(item=>item.key===marketKey);
      if(!market?.outcomes.length)continue;
      const marginTotal=market.outcomes.reduce((sum,outcome)=>sum+(outcome.price>1?1/outcome.price:0),0);
      if(!marginTotal)continue;
      for(const outcome of market.outcomes){
        if(!Number.isFinite(outcome.price)||outcome.price<=1)continue;
        const key=`${outcome.name}|${outcome.point??""}`;
        const quote={...outcome,book:book.title,probability:(1/outcome.price)/marginTotal};
        grouped.set(key,[...(grouped.get(key)??[]),quote]);
      }
    }
    return [...grouped.entries()].filter(([,quotes])=>quotes.length>=1).map(([key,quotes])=>{
      const probability=quotes.reduce((sum,q)=>sum+q.probability,0)/quotes.length;
      const average=quotes.reduce((sum,q)=>sum+q.price,0)/quotes.length;
      const low=Math.min(...quotes.map(q=>q.price)),high=Math.max(...quotes.map(q=>q.price));
      const relativeRange=(high-low)/average;
      const agreement=quotes.length===1?0.42:clamp(1-relativeRange/0.14,0,1);
      const coverage=clamp(quotes.length/3,0,1);
      const fairOdd=1/probability;
      const value=clamp((high/fairOdd-1)/0.12,0,1);
      const probabilityQuality=clamp(probability/0.55,0.25,1);
      const marketWeight=coreMarkets.includes(marketKey)?1:0.96;
      const score=Math.round(100*(agreement*0.35+coverage*0.25+value*0.25+probabilityQuality*0.15)*marketWeight);
      const [outcomeName,pointText]=key.split("|");
      const point=pointText===""?undefined:Number(pointText);
      return{marketKey,selection:selectionName(marketKey,outcomeName,point),outcomeName,point,probability,score,quotes,low,high,fairOdd:Number(fairOdd.toFixed(2))};
    });
  });
}

function mergeEvent(base:Event,detail:Event){
  const books=new Map(base.bookmakers.map(book=>[book.title,{...book,markets:[...book.markets]}]));
  for(const book of detail.bookmakers??[]){const found=books.get(book.title);if(!found){books.set(book.title,book);continue}const markets=new Map(found.markets.map(m=>[m.key,m]));for(const market of book.markets)markets.set(market.key,market);found.markets=[...markets.values()]}
  return{...base,bookmakers:[...books.values()]};
}

async function apiSports<T>(url:string,key:string,ttlSeconds:number){
  const response=await fetch(url,{headers:{"x-apisports-key":key},cf:{cacheTtl:ttlSeconds,cacheEverything:true} as never});
  if(!response.ok)return{data:[] as T,remaining:null};
  const body=await response.json() as ApiResult<T>;
  const remaining=Number(response.headers.get("x-ratelimit-requests-remaining"));
  return{data:body.response??([] as T),remaining:Number.isFinite(remaining)?remaining:null};
}

function matchEvents(events:Event[],footballFixtures:any[],basketballGames:any[]){
  const football=footballFixtures.map(item=>({sport:"Futbol" as const,id:item.fixture?.id,homeId:item.teams?.home?.id,awayId:item.teams?.away?.id,home:item.teams?.home?.name??"",away:item.teams?.away?.name??"",startsAt:item.fixture?.date??""}));
  const basketball=basketballGames.map(item=>({sport:"Basketbol" as const,id:item.id,homeId:item.teams?.home?.id,awayId:item.teams?.away?.id,home:item.teams?.home?.name??"",away:item.teams?.away?.name??"",season:item.league?.season,startsAt:item.date??""}));
  const map=new Map<string,SportsMatch>();
  for(const event of events){const pool=event.sport_key.startsWith("basketball")?basketball:football;let best:{item:SportsMatch;score:number}|null=null;for(const item of pool){const timeDiff=Math.abs(new Date(item.startsAt).getTime()-new Date(event.commence_time).getTime())/3600000;if(timeDiff>18)continue;const direct=(teamSimilarity(event.home_team,item.home)+teamSimilarity(event.away_team,item.away))/2;const reversed=(teamSimilarity(event.home_team,item.away)+teamSimilarity(event.away,item.home))/2*0.65;const score=Math.max(direct,reversed);if(score>=0.46&&(!best||score>best.score))best={item,score}}if(best)map.set(event.id,best.item)}
  return map;
}

const completedFootball=(games:any[])=>games.filter(game=>game.fixture?.status?.short==="FT"&&game.fixture?.date).sort((a,b)=>new Date(b.fixture.date).getTime()-new Date(a.fixture.date).getTime());
const completedBasketball=(games:any[])=>games.filter(game=>["FT","AOT"].includes(game.status?.short)&&game.date).sort((a,b)=>new Date(b.date).getTime()-new Date(a.date).getTime());
const daysRest=(startsAt:string,lastAt?:string)=>lastAt?Math.max(0,Math.floor((new Date(startsAt).getTime()-new Date(lastAt).getTime())/86400000)):undefined;

async function footballContext(match:SportsMatch,key:string):Promise<AnalysisContext>{
  const base="https://v3.football.api-sports.io";
  const [prediction,injuries,lineups,homeGames,awayGames]=await Promise.all([
    apiSports<any[]>(`${base}/predictions?fixture=${match.id}`,key,1800),apiSports<any[]>(`${base}/injuries?fixture=${match.id}`,key,900),apiSports<any[]>(`${base}/fixtures/lineups?fixture=${match.id}`,key,300),apiSports<any[]>(`${base}/fixtures?team=${match.homeId}&last=5`,key,3600),apiSports<any[]>(`${base}/fixtures?team=${match.awayId}&last=5`,key,3600)
  ]);
  const item=prediction.data[0],percent=item?.predictions?.percent;
  const home=percentNumber(percent?.home),draw=percentNumber(percent?.draw),away=percentNumber(percent?.away);
  const formHome=percentNumber(item?.comparison?.form?.home),formAway=percentNumber(item?.comparison?.form?.away);
  const homeLast=completedFootball(homeGames.data)[0]?.fixture?.date,awayLast=completedFootball(awayGames.data)[0]?.fixture?.date;
  const homeRest=daysRest(match.startsAt,homeLast),awayRest=daysRest(match.startsAt,awayLast);
  const signals:string[]=[];
  if(formHome!=null&&formAway!=null)signals.push(`Form karşılaştırması: ev %${Math.round(formHome*100)}, deplasman %${Math.round(formAway*100)}`);
  signals.push(`Sakatlık kaydı: ev ${injuries.data.filter((x:any)=>x.team?.id===match.homeId).length}, deplasman ${injuries.data.filter((x:any)=>x.team?.id===match.awayId).length}`);
  if(homeRest!=null&&awayRest!=null)signals.push(`Dinlenme: ev ${homeRest} gün, deplasman ${awayRest} gün`);
  signals.push(lineups.data.length>=2?"İlk 11 verisi geldi":"İlk 11 henüz açıklanmadı");
  return{probabilities:home!=null&&away!=null?{home,draw,away}:undefined,signals,underOver:item?.predictions?.under_over,warning:lineups.data.length>=2?undefined:"Maç saatine yakın kadroyu yeniden kontrol et"};
}

function basketballRecord(games:any[],teamId:number){const recent=completedBasketball(games).slice(0,5);let wins=0,forTotal=0,againstTotal=0;for(const game of recent){const isHome=game.teams?.home?.id===teamId;const own=Number(isHome?game.scores?.home?.total:game.scores?.away?.total),opp=Number(isHome?game.scores?.away?.total:game.scores?.home?.total);if(Number.isFinite(own)&&Number.isFinite(opp)){if(own>opp)wins++;forTotal+=own;againstTotal+=opp}}return{count:recent.length,wins,forAvg:recent.length?forTotal/recent.length:0,againstAvg:recent.length?againstTotal/recent.length:0,lastAt:recent[0]?.date}}
async function basketballContext(match:SportsMatch,key:string):Promise<AnalysisContext>{
  const base="https://v1.basketball.api-sports.io",season=encodeURIComponent(match.season??String(new Date(match.startsAt).getFullYear()));
  const [homeGames,awayGames]=await Promise.all([apiSports<any[]>(`${base}/games?team=${match.homeId}&season=${season}`,key,3600),apiSports<any[]>(`${base}/games?team=${match.awayId}&season=${season}`,key,3600)]);
  const h=basketballRecord(homeGames.data,match.homeId),a=basketballRecord(awayGames.data,match.awayId),sample=Math.min(h.count,a.count);
  const homeStrength=sample?clamp((h.wins/Math.max(1,h.count))*0.55+(a.againstAvg?clamp((h.forAvg-a.againstAvg+18)/36,0,1):0.5)*0.45,0.08,0.92):undefined;
  const homeRest=daysRest(match.startsAt,h.lastAt),awayRest=daysRest(match.startsAt,a.lastAt),signals:string[]=[];
  if(sample)signals.push(`Son ${sample} maç: ev ${h.wins} galibiyet, deplasman ${a.wins} galibiyet`);
  if(h.count&&a.count)signals.push(`Sayı ortalaması: ev ${h.forAvg.toFixed(1)}, deplasman ${a.forAvg.toFixed(1)}`);
  if(homeRest!=null&&awayRest!=null)signals.push(`Dinlenme: ev ${homeRest} gün, deplasman ${awayRest} gün`);
  const predictedTotal=h.count&&a.count?(h.forAvg+h.againstAvg+a.forAvg+a.againstAvg)/2:undefined;
  return{probabilities:homeStrength!=null?{home:homeStrength,away:1-homeStrength}:undefined,signals,predictedTotal,warning:sample<3?"Basketbol form örneklemi sınırlı":undefined};
}

function modelProbability(event:Event,choice:Candidate,context?:AnalysisContext){
  let stat:number|undefined;
  if(context?.probabilities&&choice.marketKey==="h2h"){const name=normalize(choice.outcomeName);stat=name.includes("draw")||name.includes("beraberlik")?context.probabilities.draw:teamSimilarity(choice.outcomeName,event.home_team)>.6?context.probabilities.home:teamSimilarity(choice.outcomeName,event.away_team)>.6?context.probabilities.away:undefined}
  if(context?.probabilities&&choice.marketKey.startsWith("spreads"))stat=teamSimilarity(choice.outcomeName,event.home_team)>.6?context.probabilities.home:teamSimilarity(choice.outcomeName,event.away_team)>.6?context.probabilities.away:undefined;
  if(context?.predictedTotal!=null&&choice.marketKey.startsWith("totals")&&choice.point!=null){const over=1/(1+Math.exp(-(context.predictedTotal-choice.point)/10));stat=choice.outcomeName.toLowerCase()==="over"?over:1-over}
  if(context?.underOver&&choice.marketKey.startsWith("totals")&&choice.point!=null){const hintedUnder=context.underOver.startsWith("-");const hintedLine=Number(context.underOver.replace(/[^0-9.]/g,""));if(Number.isFinite(hintedLine)&&Math.abs(hintedLine-choice.point)<=1){const matches=hintedUnder?choice.outcomeName.toLowerCase()==="under":choice.outcomeName.toLowerCase()==="over";stat=matches?0.62:0.38}}
  const probability=stat==null?choice.probability:clamp(choice.probability*0.58+stat*0.42,0.01,0.97);
  return{probability,statUsed:stat!=null};
}

const publicChoice=(choice:ModelChoice,tag?:string)=>({
  selection:choice.selection,
  market:marketName(choice.marketKey),
  currentOdd:choice.high,
  fairOdd:Number((1/choice.probability).toFixed(2)),
  confidence:choice.score,
  probability:Math.round(choice.probability*100),
  tag
});

export async function GET(request:Request){
  const suppliedKey=request.headers.get("x-oranradar-key")?.trim();
  const includeExtraMarkets=request.headers.get("x-oranradar-extra-markets")!=="0";
  const minProbability=clamp(Number(request.headers.get("x-oranradar-min-probability")??60),0,95)/100;
  const oddsKey=suppliedKey||process.env.ODDS_API_KEY,sportsKey=process.env.API_SPORTS_KEY;if(!oddsKey)return demo();
  const keyBytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${oddsKey}:${includeExtraMarkets}:${minProbability}`));
  const cacheKey=Array.from(new Uint8Array(keyBytes)).slice(0,8).map(value=>value.toString(16).padStart(2,"0")).join("");
  const cached=responseCaches.get(cacheKey);if(cached&&cached.until>Date.now())return NextResponse.json(cached.payload,{headers:{"Cache-Control":"private, max-age=300"}});
  try{
    const responses=await Promise.all(sports.map(async sport=>{const url=new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);url.searchParams.set("apiKey",oddsKey);url.searchParams.set("bookmakers","pinnacle,betfair_ex_uk,bet365");url.searchParams.set("markets","h2h,spreads,totals");url.searchParams.set("oddsFormat","decimal");url.searchParams.set("commenceTimeFrom",oddsDate(new Date()));url.searchParams.set("commenceTimeTo",oddsDate(new Date(Date.now()+72*60*60*1000)));let response=await fetch(url,{cache:"no-store"});let events=response.ok?await response.json() as Event[]:[];if(!Array.isArray(events)||!events.some(event=>event.bookmakers?.length)){url.searchParams.delete("bookmakers");url.searchParams.set("regions","eu");response=await fetch(url,{cache:"no-store"});events=response.ok?await response.json() as Event[]:[]}const valid=Array.isArray(events)?events.filter(event=>event.bookmakers?.length):[];return{status:response.status,events:valid,remaining:Number(response.headers.get("x-requests-remaining")),used:Number(response.headers.get("x-requests-used")),lastCost:Number(response.headers.get("x-requests-last"))}}));
    const statuses=responses.map(item=>item.status);if(statuses.every(status=>status===401||status===403))return NextResponse.json({demo:false,picks:[],keyError:true,error:"API anahtarı geçersiz. Ayarlar bölümünden yeni anahtarı kaydet."},{status:401,headers:{"Cache-Control":"no-store"}});if(statuses.every(status=>status===429))return NextResponse.json({demo:false,picks:[],keyError:true,error:"Veri kredisi bitti. Yeni anahtarı Ayarlar bölümünden kaydet."},{status:429,headers:{"Cache-Control":"no-store"}});
    let results=responses.flatMap(item=>item.events);
    const prelim=includeExtraMarkets?results.filter(e=>e.sport_key.startsWith("soccer")).map(event=>({event,score:Math.max(0,...candidates(event).map(c=>c.score))})).sort((a,b)=>b.score-a.score).slice(0,2):[];
    const detailResponses=await Promise.all(prelim.map(async({event})=>{const url=new URL(`https://api.the-odds-api.com/v4/sports/${event.sport_key}/events/${event.id}/odds`);url.searchParams.set("apiKey",oddsKey);url.searchParams.set("bookmakers","pinnacle,betfair_ex_uk,bet365");url.searchParams.set("markets",extraFootballMarkets.join(","));url.searchParams.set("oddsFormat","decimal");let response=await fetch(url,{cache:"no-store"});let detail=response.ok?await response.json() as Event:null;if(!detail?.bookmakers?.length){url.searchParams.delete("bookmakers");url.searchParams.set("regions","eu");response=await fetch(url,{cache:"no-store"});detail=response.ok?await response.json() as Event:null}return{event:detail?.bookmakers?.length?detail:null,remaining:Number(response.headers.get("x-requests-remaining")),used:Number(response.headers.get("x-requests-used")),lastCost:Number(response.headers.get("x-requests-last"))}}));
    const detailMap=new Map(detailResponses.filter(x=>x.event).map(x=>[x.event!.id,x.event!]));results=results.map(event=>detailMap.has(event.id)?mergeEvent(event,detailMap.get(event.id)!):event);
    const contextMap=new Map<string,AnalysisContext>();
    if(sportsKey&&results.length){const dates=[...new Set([0,1,2,3].map(i=>dateKey(new Date(Date.now()+i*86400000))))];const footballFixtures=(await Promise.all(dates.map(date=>apiSports<any[]>(`https://v3.football.api-sports.io/fixtures?date=${date}&timezone=Europe%2FIstanbul`,sportsKey,600)))).flatMap(x=>x.data);const basketballGames=(await Promise.all(dates.map(date=>apiSports<any[]>(`https://v1.basketball.api-sports.io/games?date=${date}&timezone=Europe%2FIstanbul`,sportsKey,600)))).flatMap(x=>x.data);const matches=matchEvents(results,footballFixtures,basketballGames);const shortlist=results.map(event=>({event,score:Math.max(0,...candidates(event).map(c=>c.score))})).sort((a,b)=>b.score-a.score).slice(0,4);await Promise.all(shortlist.map(async({event})=>{const match=matches.get(event.id);if(!match)return;contextMap.set(event.id,match.sport==="Futbol"?await footballContext(match,sportsKey):await basketballContext(match,sportsKey))}))}
    const allQuota=[...responses,...detailResponses],remainingValues=allQuota.map(item=>item.remaining).filter(Number.isFinite),usedValues=allQuota.map(item=>item.used).filter(Number.isFinite);const quota={remaining:remainingValues.length?Math.min(...remainingValues):null,used:usedValues.length?Math.max(...usedValues):null,lastCost:allQuota.reduce((sum,item)=>sum+(Number.isFinite(item.lastCost)?item.lastCost:0),0)};
    const ranked=results.flatMap(event=>{
      const context=contextMap.get(event.id);
      const modeled=candidates(event).map(choice=>{
        const model=modelProbability(event,choice,context),edge=choice.high*model.probability-1,boost=clamp(edge/0.45,-1,1);
        return{...choice,...model,score:Math.round(clamp(choice.score*0.76+Math.max(0,boost)*24+Math.min(0,boost)*14,0,99))} as ModelChoice;
      });
      const unique=[...new Map(modeled.sort((a,b)=>(b.score+b.probability*10)-(a.score+a.probability*10)).map(choice=>[choice.marketKey,choice])).values()];
      const qualified=unique.filter(choice=>choice.probability>=minProbability).slice(0,5);
      const best=qualified[0];
      if(!best)return[];
      const surprise=unique
        .filter(choice=>choice.marketKey!==best.marketKey&&choice.high>=2.4&&choice.probability>=Math.max(0.22,minProbability*0.55))
        .sort((a,b)=>(b.high*b.probability+b.score/100)-(a.high*a.probability+a.score/100))[0];
      const alternatives=[...qualified.slice(1,4).map(choice=>publicChoice(choice)),...(surprise?[publicChoice(surprise,"Sürpriz aday")]:[])];
      const probabilityPercent=Math.round(best.probability*100);
      return[{id:`${event.id}|${best.marketKey}|${best.selection}`,sport:event.sport_key.startsWith("basketball")?"Basketbol":"Futbol",league:leagueName(event.sport_title),home:event.home_team,away:event.away_team,startsAt:event.commence_time,market:marketName(best.marketKey),selection:best.selection,currentOdd:best.high,openingOdd:best.high,fairOdd:Number((1/best.probability).toFixed(2)),confidence:best.score,probability:probabilityPercent,sources:best.quotes.map(q=>({name:q.book,odd:q.price})),signals:[`${best.statUsed?"Model":"Piyasa"} olasılığı %${probabilityPercent}`,`${best.quotes.length} oran kaynağı karşılaştırıldı`,`Kaynak fiyat aralığı ${best.low.toFixed(2)} ile ${best.high.toFixed(2)}`,...(context?.signals??[])],alternatives,warning:context?.warning??(!sportsKey?"Takım istatistik anahtarı bağlı değil":context?undefined:"Takım verisi eşleşmedi, yüzde piyasa oranından hesaplandı")}]
    }).sort((a,b)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime());
    const seenTeams=new Set<string>();const picks=ranked.filter(pick=>pick.confidence>=34).filter(pick=>{const home=normalize(pick.home),away=normalize(pick.away);if(seenTeams.has(home)||seenTeams.has(away))return false;seenTeams.add(home);seenTeams.add(away);return true}).slice(0,8);
    const payload={demo:false,picks,quota};responseCaches.set(cacheKey,{until:Date.now()+300000,payload});return NextResponse.json(payload,{headers:{"Cache-Control":"private, max-age=300"}});
  }catch{return demo()}
}
