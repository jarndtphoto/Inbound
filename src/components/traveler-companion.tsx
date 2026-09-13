import { useEffect, useRef, useState } from "react";
import type { FlightStory } from "@/lib/types";
import { isLanded, journeyChanges, journeyKey, nextStep, type AlertKind, type JourneyAlert } from "@/lib/traveler";
const labels:Record<AlertKind,string>={delay:"Material delay changes",gate:"Gate changes",stage:"Movement and arrival"};
const prefsKey="inbound-alert-preferences-v1";
export function TravelerCompanion({story, failed=false}:{story:FlightStory;failed?:boolean}) {
  const [now,setNow]=useState(story.fetchedAt);
  const [prefs,setPrefs]=useState<Record<AlertKind,boolean>>({delay:true,gate:true,stage:true});
  const [events,setEvents]=useState<JourneyAlert[]>([]);
  const previous=useRef<FlightStory|null>(null);
  const [notice,setNotice]=useState("");
  const key=journeyKey(story);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),15000);setNow(Date.now());return()=>clearInterval(t)},[]);
  useEffect(()=>{try{const p=JSON.parse(localStorage.getItem(prefsKey)||"null");if(p)setPrefs({delay:p.delay!==false,gate:p.gate!==false,stage:p.stage!==false})}catch{}},[]);
  useEffect(()=>{
    previous.current=null;setNotice("");
    try{const saved=JSON.parse(localStorage.getItem("inbound-events:"+key)||"[]");setEvents(Array.isArray(saved)?saved.filter(e=>e&&typeof e.text==="string"&&typeof e.at==="number").slice(-30):[])}catch{setEvents([])}
  },[key]);
  useEffect(()=>{
    if(failed || Date.now()-story.fetchedAt>60000)return;
    const old=previous.current;previous.current=story;
    if(!old)return;
    const changes=journeyChanges(old,story);
    if(!changes.length)return;
    setEvents(es=>{const all=[...es,...changes].slice(-30);try{localStorage.setItem("inbound-events:"+key,JSON.stringify(all))}catch{}return all});
    const selected=changes.filter(e=>prefs[e.kind]);if(selected.length)setNotice(selected.map(e=>e.text).join(" "));
  },[story,key,failed,prefs]);
  const step=nextStep(story,now,failed);
  let localTime="Local time unavailable";
  if(story.dest.tz)try{localTime=new Intl.DateTimeFormat(undefined,{timeZone:story.dest.tz,hour:"numeric",minute:"2-digit",timeZoneName:"short"}).format(now)}catch{}
  return <div className="mt-5 space-y-4">
    {notice&&<div role="status" aria-live="polite" className="rounded-xl border border-accent bg-surface p-4"><p className="text-sm">{notice}</p><button className="mt-2 min-h-11 text-sm underline" onClick={()=>setNotice("")}>Dismiss update</button></div>}
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="What happens next">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">What happens next</p>
      <h2 className="mt-2 text-xl font-semibold">{step.title}</h2><p className="mt-2 text-sm leading-relaxed">{step.body}</p>
      <p className="mt-3 text-xs text-muted">{step.confidence} · Updated {new Date(story.fetchedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</p>
      <details className="mt-3 text-sm"><summary className="min-h-11 cursor-pointer py-3">How to read your flight data</summary>
        <p>Reported times come from the flight-status feed. Estimates can change. A recent aircraft position supports movement, but it does not identify a gate by itself.</p>
      </details>
    </section>
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="Arrival help">
      <h2 className="text-lg font-semibold">Arriving in {story.dest.city}</h2><p className="mt-1 text-sm text-muted">{localTime}</p>
      <dl className="mt-3 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-muted">Arrival gate</dt><dd className="mt-1 font-semibold">{story.times.destGate||"Not assigned"}</dd></div><div><dt className="text-muted">{story.times.gateKind==="actual"?"Reported gate arrival":"Estimated gate arrival"}</dt><dd className="mt-1 font-semibold">{story.times.gate||"Awaiting update"}</dd></div></dl>
      {isLanded(story)&&story.currentStage!=="gate"&&<p className="mt-3 text-sm">Landed; waiting for gate confirmation.</p>}
      <details className="mt-3 text-sm"><summary className="min-h-11 cursor-pointer py-3">Connections and baggage</summary><p>Terminal, baggage belt, and connection walking times are not supplied by the current feed. Check your airline app and airport displays. Gate labels alone do not establish the terminal or connection time.</p></details>
    </section>
    <details className="rounded-xl border border-border bg-surface p-5"><summary className="cursor-pointer py-2 font-semibold">Important changes {events.length? "("+events.length+")":""}</summary>
      <p className="mt-2 text-xs text-muted">Recorded on this device while this flight is open. Changes during gaps in tracking may be missing.</p>
      {events.length?<ol className="mt-3 space-y-3">{events.slice().reverse().map((e,i)=><li key={e.at+":"+i} className="text-sm"><time className="block text-xs text-muted">{new Date(e.at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</time>{e.text}</li>)}</ol>:<p className="mt-3 text-sm text-muted">No new material changes recorded yet.</p>}
    </details>
    <details className="rounded-xl border border-border bg-surface p-5"><summary className="cursor-pointer py-2 font-semibold">Alert preferences</summary>
      <p className="mt-2 text-sm text-muted">Show alerts here while Inbound is open. Background phone notifications are not enabled.</p>
      {(Object.keys(labels) as AlertKind[]).map(k=><label key={k} className="flex min-h-11 items-center gap-3 py-2 text-sm"><input type="checkbox" checked={prefs[k]} onChange={e=>{const p={...prefs,[k]:e.target.checked};setPrefs(p);try{localStorage.setItem(prefsKey,JSON.stringify(p))}catch{}}}/>{labels[k]}</label>)}
    </details>
  </div>;
}
