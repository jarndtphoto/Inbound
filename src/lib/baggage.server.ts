export type BaggageLeg = { flight: string; origin: string; destination: string; date: string };
export type BaggageResult = { status: "posted" | "not-posted" | "unavailable"; carousel?: string; terminal?: string; checkedAt: number };
const boardUrl = "https://tracker.flightview.com/FVAccess3/tools/fids/fidsDefault.asp?accCustId=HawaiiAirports&fidsId=20002&fidsInit=arrivals&fidsApt=HNL";
let cached: {html:string;at:number}|undefined;
let pending: Promise<{html:string;at:number}>|undefined;

/** Read the airport's public board without executing its embedded scripts. */
export function parseBaggage(html:string, leg:BaggageLeg, checkedAt:number):BaggageResult {
  const matches: BaggageResult[] = [];
  for(const row of html.split(/<div\s+role="row"/).slice(1)) {
    const metadata = row.match(/\{fn:'([^']+)',al:'([^']+)',alname:'[^']*',depdate:'(\d{8})',deptime:'\d{4}',status:'[^']*',depap:'([^']+)'[^}]*?arrap:'([^']+)',arrterm:'([^']*)'/);
    if(!metadata)continue;
    const [,number,airline,date,origin,destination,terminal]=metadata;
    if(airline+number!==leg.flight || date!==leg.date.replaceAll("-","") || origin!==leg.origin || destination!==leg.destination)continue;
    const cell=row.match(/<div\s+role="cell"\s+class="[^"]*\bc11\b[^"]*">([\s\S]*?)<\/div>/);
    if(!cell)continue;
    const carousel=cell[1].replace(/<[^>]*>/g,"").replace(/&(?:nbsp|#160);/g," ").trim();
    if(carousel && !/^[A-Za-z0-9 -]{1,16}$/.test(carousel))continue;
    matches.push({status:carousel?"posted":"not-posted",...(carousel?{carousel}:{}),...(/^[A-Za-z0-9 -]{1,12}$/.test(terminal)?{terminal}:{}),checkedAt});
  }
  return matches.length===1?matches[0]:{status:"unavailable",checkedAt};
}
export async function loadBaggage(leg:BaggageLeg):Promise<BaggageResult> {
  if(leg.destination!=="HNL")return {status:"unavailable",checkedAt:Date.now()};
  try {
    if(!cached || Date.now()<cached.at || Date.now()-cached.at>120000){
      pending ??= (async()=>{
        const response=await fetch(boardUrl,{signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw new Error("Baggage board unavailable");
        const html=await response.text();
        if(html.length>4000000 || !html.includes('role="row"'))throw new Error("Unrecognized baggage board");
        return cached={html,at:Date.now()};
      })().finally(()=>{pending=undefined});
      await pending;
    }
    return parseBaggage(cached!.html,leg,cached!.at);
  }catch{return {status:"unavailable",checkedAt:Date.now()};}
}
