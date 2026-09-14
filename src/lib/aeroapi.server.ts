// Server-only: never return credentials or upstream response bodies to clients.
type Row = Record<string, any>;
const stamp = (v:unknown):number|null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v)/1000 : null;
const text = (v:unknown):string|null => typeof v==='string' && v.trim() ? v.trim() : null;

const airportCode = (airport:Row|undefined):string|null => text(airport?.code_iata) ?? text(airport?.code_icao) ?? text(airport?.code);
const diversionReported = (f:Row) => f.diverted === true || /^diverted\b/i.test(text(f.status) ?? '');
/** Join only an unambiguous diversion pair for the same dated provider instance. */
export function mergeAeroDiversions(rows:Row[]):Row[] {
  const grouped=new Map<string,Row[]>();
  const key=(f:Row) => {
    const departure=stamp(f.actual_off) ?? stamp(f.scheduled_off) ?? stamp(f.actual_out) ?? stamp(f.scheduled_out);
    return text(f.fa_flight_id) && airportCode(f.origin) && departure != null
      ? JSON.stringify([f.fa_flight_id,airportCode(f.origin),departure]) : null;
  };
  for(const f of rows) { if(!f)continue; const k=key(f); if(k)grouped.set(k,[...(grouped.get(k)??[]),f]); }
  const replaced=new Map<Row,Row>(), removed=new Set<Row>();
  for(const group of grouped.values()) {
    const originals=group.filter(diversionReported);
    const revised=group.filter(f=>!diversionReported(f));
    if(originals.length!==1 || revised.length!==1)continue;
    const original=originals[0], update=revised[0];
    const from=airportCode(original.destination), to=airportCode(update.destination);
    if(!from || !to || from===to || (original.registration && update.registration && original.registration!==update.registration))continue;
    removed.add(original);
    replaced.set(update,{...update,diverted:true,_diversion:{originalDestination:from,destination:to}});
  }
  return rows.filter(f=>f&&!removed.has(f)).map(f=>replaced.get(f)??f);
}

export function selectAeroFlight(rows:Row[], ident:string, now=Date.now()/1000, exact=false):Row|null {
  rows=mergeAeroDiversions(rows);
  const matching=rows.filter(f=>f && f.origin && f.destination && (exact ? f.fa_flight_id===ident : [f.ident,f.ident_icao,f.ident_iata,...(Array.isArray(f.codeshares)?f.codeshares:[]),...(Array.isArray(f.codeshares_iata)?f.codeshares_iata:[])].includes(ident)));
  if(exact)return matching.length===1?matching[0]:null;
  const dep=(f:Row)=>stamp(f.actual_out)??stamp(f.estimated_out)??stamp(f.scheduled_out)??stamp(f.scheduled_off)??Infinity;
  const arrival=(f:Row)=>stamp(f.actual_in)??stamp(f.actual_on);
  const active=matching.filter(f=>!f.cancelled && stamp(f.actual_in)==null && (stamp(f.actual_out)??stamp(f.actual_off))!=null && dep(f)<=now && now-dep(f)<36*3600).sort((a,b)=>dep(b)-dep(a));
  if(active.length)return active[0];
  const upcoming=matching.filter(f=>!f.cancelled && !f.actual_out && !f.actual_off && dep(f)>=now-6*3600 && dep(f)<=now+24*3600).sort((a,b)=>dep(a)-dep(b));
  if(upcoming[0] && dep(upcoming[0])<=now+3*3600)return upcoming[0];
  const recent=matching.filter(f=>arrival(f)!=null && arrival(f)!<=now && now-arrival(f)!<6*3600).sort((a,b)=>arrival(b)!-arrival(a)!);
  return recent[0]??upcoming[0]??matching.filter(f=>f.cancelled && Math.abs(dep(f)-now)<12*3600).sort((a,b)=>Math.abs(dep(a)-now)-Math.abs(dep(b)-now))[0]??null;
}
export function mapAeroFlight(f:Row, confirmedAt=Date.now()) {
  const o=f.origin??{},d=f.destination??{};
  const times=(event:string)=>({scheduled:stamp(f['scheduled_'+event]),estimated:stamp(f['estimated_'+event]),actual:stamp(f['actual_'+event])});
  return {
    flightId:text(f.fa_flight_id),
    diversion:diversionReported(f) ? {source:'flightaware' as const,reportedAt:confirmedAt,originalDestination:f._diversion?.originalDestination ?? null,destination:f._diversion?.destination ?? null} : undefined,
    ident:text(f.ident_icao)??text(f.ident),iataIdent:text(f.ident_iata),status:text(f.status)??'',confirmedAt,
    originIata:text(o.code_iata),originIcao:text(o.code_icao)??text(o.code),originName:text(o.name),originCity:text(o.city),originTz:text(o.timezone),originLat:null,originLon:null,originGate:text(f.gate_origin),
    destIata:text(d.code_iata),destIcao:text(d.code_icao)??text(d.code),destName:text(d.name),destCity:text(d.city),destTz:text(d.timezone),destLat:null,destLon:null,destGate:text(f.gate_destination),
    gateOut:times('out'),takeoff:times('off'),landing:times('on'),gateIn:times('in'),
    inboundIdent:null,inbound:null,inboundFlightId:text(f.inbound_fa_flight_id),waypoints:[],
    type:text(f.aircraft_type),tail:text(f.registration),hex:null,atcIdent:text(f.atc_ident),cancelled:f.cancelled===true,
    averageDelaySec:{departure:null,arrival:null},typicalTaxiOutMin:null,typicalTaxiInMin:null,filedTaxiOutMin:null,filedTaxiInMin:null,
    gsKt:null,heading:null,altFt:null,faTrack:[],
  };
}
const cache=new Map<string,{at:number;value:ReturnType<typeof mapAeroFlight>|null}>();
const pending=new Map<string,Promise<ReturnType<typeof mapAeroFlight>|null>>();
let requests:number[]=[];
let blockedUntil=0;
let missingLogged=false;
/** Per-instance safeguards, not an account-wide billing cap. */
export async function loadAeroFlight(ident:string,exact=false) {
  const key=process.env.FLIGHTAWARE_API_KEY?.trim();
  if(!key){if(!missingLogged){console.info('[aeroapi] key unavailable; using public feed');missingLogged=true;}return null;}
  if(!/^[A-Z0-9][A-Za-z0-9_-]{1,150}$/.test(ident))return null;
  const id=(exact?'id:':'ident:')+ident, now=Date.now();
  const previous=cache.get(id);
  if(previous && now>=previous.at && now-previous.at<120000)return previous.value;
  if(pending.has(id))return pending.get(id)!;
  if(now<blockedUntil)return null;
  requests=requests.filter(t=>now-t<60000 && now>=t);
  if(requests.length>=6)return null;
  requests.push(now);
  const task=(async()=>{
    try {
      const params=new URLSearchParams({max_pages:'1'});
      // Use the documented default date window; personal plans may reject historical windows.
      const response=await fetch('https://aeroapi.flightaware.com/aeroapi/flights/'+encodeURIComponent(ident)+'?'+params,{headers:{'x-apikey':key,Accept:'application/json'},signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!response.ok){blockedUntil=Date.now()+([401,402,403].includes(response.status)?15*60000:60000);console.warn('[aeroapi] request failed HTTP '+response.status);return null;}
      const body=await response.json();
      if(!Array.isArray(body.flights))throw Error('Invalid response');
      const selected=selectAeroFlight(body.flights,ident,Date.now()/1000,exact);
      const value=selected?mapAeroFlight(selected):null;
      if(cache.size>=100)cache.delete(cache.keys().next().value!);
      cache.set(id,{at:Date.now(),value});
      console.info('[aeroapi] '+ident+' '+(value?'matched flight':'no matching flight'));
      return value;
    }catch{blockedUntil=Date.now()+60000;console.warn('[aeroapi] request unavailable');return null;}
    finally{pending.delete(id);}
  })();
  pending.set(id,task);
  return task;
}
