import { useEffect, useState } from "react";
import { getBaggage } from "@/lib/baggage";
import type { BaggageResult } from "@/lib/baggage.server";

export type BaggageStatusState = {
  result: BaggageResult | null;
  supported: boolean;
  loading: boolean;
};

export function useBaggageStatus({flight,origin,destination,date}:{flight:string;origin:string;destination:string;date:string|null}): BaggageStatusState {
  const key=[flight,origin,destination,date].join("/");
  const [result,setResult]=useState<{key:string;value:BaggageResult}|null>(null);
  const supported=destination==="HNL" && Boolean(date);
  useEffect(()=>{
    if(!supported || !date)return;
    let cancelled=false;
    let timer:ReturnType<typeof setTimeout>;
    async function update(){
      try {
        const value=await getBaggage({data:{flight,origin,destination,date:date!}});
        if(!cancelled)setResult({key,value});
      }catch{if(!cancelled)setResult({key,value:{status:"unavailable",checkedAt:Date.now()}});}
      if(!cancelled)timer=setTimeout(update,120000);
    }
    void update();
    return()=>{cancelled=true;clearTimeout(timer)};
  },[key,flight,origin,destination,date,supported]);
  const value=result?.key===key?result.value:null;
  return {result:value,supported,loading:supported&&!value};
}

export function BaggageStatus({state}:{state:BaggageStatusState}) {
  const {result:value,supported,loading}=state;
  return <>
    <p className="font-semibold">{value?.status==="posted"?`Carousel ${value.carousel}${value.terminal?` · Terminal ${value.terminal}`:""}`:loading?"Checking baggage claim…":"Baggage claim hasn't been assigned yet."}</p>
    {value && value.status!=="unavailable" ? <p className="mt-1 text-xs text-muted"><a className="underline" href="https://airports.hawaii.gov/hnl/flights/" target="_blank" rel="noopener noreferrer">Honolulu airport arrivals board ↗</a> · Checked {new Date(value.checkedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}. Confirm on arrival; assignments can change.</p> : <p className="mt-1 text-xs text-muted">{supported?"Check airport displays after arrival if an assignment is not available here yet.":"Automatic baggage assignments aren’t available for this airport yet. Check airport displays after arrival."}</p>}
  </>;
}
