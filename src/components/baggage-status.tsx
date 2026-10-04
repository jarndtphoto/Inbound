import { formatClockTime } from "@/lib/presentation-time";
import { useEffect, useState } from "react";
import { getBaggage } from "@/lib/baggage";
import type { BaggageResult } from "@/lib/baggage.server";

export type BaggageStatusState = {
  result: BaggageResult | null;
  supported: boolean;
  loading: boolean;
};

const FALLBACK_AIRPORTS = new Set(["HNL", "LAX", "ORD", "MDW", "MCO", "BOS"]);

export function useBaggageStatus({flight,origin,destination,date}:{flight:string;origin:string;destination:string;date:string|null}): BaggageStatusState {
  const key=[flight,origin,destination,date].join("/");
  const [result,setResult]=useState<{key:string;value:BaggageResult}|null>(null);
  const supported=Boolean(date);
  useEffect(()=>{
    if(!supported || !date)return;
    let cancelled=false;
    let timer:ReturnType<typeof setTimeout>;
    async function update(){
      let value:BaggageResult;
      try {
        value=await getBaggage({data:{flight,origin,destination,date:date!}});
      }catch{
        value={status:"unavailable",checkedAt:Date.now()};
      }
      if(!cancelled)setResult({key,value});
      const fallbackCanChange=FALLBACK_AIRPORTS.has(destination) || /^AS\d{1,4}$/.test(flight.toUpperCase());
      if(!cancelled && (value.status!=="unavailable" || fallbackCanChange)) timer=setTimeout(update,120000);
    }
    void update();
    return()=>{cancelled=true;clearTimeout(timer)};
  },[key,flight,origin,destination,date,supported]);
  const value=result?.key===key?result.value:null;
  return {result:value,supported,loading:supported&&!value};
}

export function BaggageStatus({state,showAssignment=true}:{state:BaggageStatusState;showAssignment?:boolean}) {
  const {result:value,supported,loading}=state;
  const source = value?.sourceUrl && value.sourceName
    ? <><a className="underline" href={value.sourceUrl} target="_blank" rel="noopener noreferrer">{value.sourceName} ↗</a> · </>
    : value?.sourceName ? <>{value.sourceName} · </> : null;
  return <>
    {showAssignment || loading ? <p className="font-semibold">{value?.status==="posted"?`Carousel ${value.carousel}${value.terminal?` · Terminal ${value.terminal}`:""}`:loading?"Checking baggage claim…":"Baggage claim hasn't been assigned yet."}</p> : null}
    {value && value.status!=="unavailable" ? <p className="mt-1 text-xs text-muted">{source}Checked {formatClockTime(value.checkedAt)}. Confirm on arrival; assignments can change.</p> : <p className="mt-1 text-xs text-muted">{supported?"Check airport displays after arrival if an assignment is not available here yet.":"Automatic baggage assignments aren’t available for this airport yet. Check airport displays after arrival."}</p>}
  </>;
}
