import type { FlightStory } from "./types.ts";

type RecordLike = {
  flightId?: string | null; ident?: string | null; iataIdent?: string | null; tail?: string | null;
  inboundFlightId?: string | null;
  gateOut?: {actual?: number | null; estimated?: number | null; scheduled?: number | null};
  takeoff?: {actual?: number | null; estimated?: number | null; scheduled?: number | null};
  diversion?: FlightStory["diversion"];
};
const tailOf=(r:RecordLike)=>String(r.tail??"").replace(/[-\s]/g,"").toUpperCase();
const departure=(r:RecordLike)=>r.gateOut?.actual ?? r.takeoff?.actual ?? r.gateOut?.estimated ?? r.gateOut?.scheduled ?? r.takeoff?.estimated ?? r.takeoff?.scheduled;
const label=(r:RecordLike)=>r.iataIdent || r.ident || "Earlier flight";

/** Follow dated inbound IDs, never current flight-number searches. Two earlier legs maximum. */
export async function findInboundDiversion(
  current:RecordLike | null | undefined,
  immediate:RecordLike | null | undefined,
  loadById:(id:string)=>Promise<RecordLike | null>,
):Promise<FlightStory["inboundDiversion"]> {
  if(!current || !tailOf(current))return undefined;
  let later=current;
  const chain=[label(current)];
  const visited=new Set<string>(current.flightId ? [current.flightId] : []);
  for(let depth=0;depth<2;depth++) {
    const id=later.inboundFlightId;
    if(!id || visited.has(id))return undefined;
    visited.add(id);
    let earlier:RecordLike|null;
    try { earlier=depth===0 && immediate?.flightId===id ? immediate : await loadById(id); }
    catch { return undefined; }
    console.info("[inbound-diversion] history check", {depth, found:Boolean(earlier), instanceMatches:earlier?.flightId===id, aircraftMatches:Boolean(earlier && tailOf(earlier)===tailOf(current)), diversionReported:Boolean(earlier?.diversion)});
    if(!earlier || earlier.flightId!==id || tailOf(earlier)!==tailOf(current))return undefined;
    const before=departure(earlier), after=departure(later);
    console.info("[inbound-diversion] departure order", {depth, before, after});
    if(before==null || after==null || !Number.isFinite(before) || !Number.isFinite(after)
      || before>=after || after-before>36*3600)return undefined;
    chain.unshift(label(earlier));
    if(earlier.diversion)return {
      source:"flightaware", reportedAt:earlier.diversion.reportedAt,
      flightId:id, flight:label(earlier), aircraft:tailOf(current),
      destination:earlier.diversion.destination, originalDestination:earlier.diversion.originalDestination,
      chain,
    };
    later=earlier;
  }
  return undefined;
}

export function inboundDiversionText(notice:NonNullable<FlightStory["inboundDiversion"]>):string {
  return "The aircraft assigned to your flight was diverted on "+notice.flight
    +(notice.destination ? " to "+notice.destination : "")
    +". "+(notice.originalDestination ? "That flight was originally bound for "+notice.originalDestination+". " : "")
    +"This does not mean your flight is diverted. Check the latest departure estimate; any effect on your flight is not yet confirmed.";
}
