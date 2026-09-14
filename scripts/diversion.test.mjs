import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeAeroDiversions,selectAeroFlight,mapAeroFlight} from '../src/lib/aeroapi.server.ts';
import {nextStep,journeyChanges} from '../src/lib/traveler.ts';

// Synthetic regression scenario supplied by the user, not a live airline record.
// Times identify one test instance; they are not claimed departure times for DL773.
const now=Date.parse('2026-09-14T01:00:00Z');
const iso=(hours)=>new Date(now+hours*3600000).toISOString();
const airport=(code_iata,code_icao)=>({code_iata,code_icao});
const original={fa_flight_id:'DAL773-test-only',ident:'DAL773',ident_icao:'DAL773',ident_iata:'DL773',
  origin:airport('JFK','KJFK'),destination:airport('HNL','PHNL'),registration:'TEST-TAIL',
  scheduled_out:iso(-8),actual_out:iso(-8),actual_off:iso(-7.8),actual_on:iso(-2),diverted:true};
const revised={...original,destination:airport('LAX','KLAX'),actual_in:iso(-1.8),diverted:false};
function story(diversion,extra={}) {
 return {fetchedAt:now,flightId:original.fa_flight_id,callsign:'DAL773',origin:{icao:'KJFK'},dest:{icao:'KLAX',city:'Los Angeles'},
   currentStage:'gate',live:false,aircraft:null,diversion,times:{origPushUnix:now/1000-8*3600,landKind:'actual',gateKind:'actual'},...extra};
}
test('DL773: joins original and diversion airport records for the same dated flight',()=>{
 const selected=selectAeroFlight([original,revised],'DAL773',now/1000);
 assert.equal(selected.destination.code_iata,'LAX');
 const mapped=mapAeroFlight(selected,now);
 assert.equal(mapped.destIata,'LAX');
 assert.deepEqual(mapped.diversion,{source:'flightaware',reportedAt:now,originalDestination:'HNL',destination:'LAX'});
 assert.equal(mapped.flightId,original.fa_flight_id);
});
test('exact provider lookup also resolves a diversion pair',()=>{
 assert.equal(selectAeroFlight([revised,original],original.fa_flight_id,now/1000,true).destination.code_iata,'LAX');
});
test('does not join different departures, origins or aircraft',()=>{
 for(const update of [
  {...revised,actual_off:iso(-31.8)},
  {...revised,origin:airport('EWR','KEWR')},
  {...revised,registration:'OTHER-TAIL'},
 ]) assert.equal(mergeAeroDiversions([original,update]).length,2);
});
test('ambiguous diversion destinations remain unmerged',()=>{
 assert.equal(mergeAeroDiversions([original,revised,{...revised,destination:airport('SFO','KSFO')}]).length,3);
});
test('flag without a matching revised record does not invent the diversion airport',()=>{
 const diversion=mapAeroFlight(original,now).diversion;
 assert.equal(diversion.destination,null);
 assert.equal(diversion.originalDestination,null);
 assert.match(nextStep(story(diversion),now).body,/not yet been confirmed/);
});
test('diverted status is recognized but a negated status is not',()=>{
 assert.ok(mapAeroFlight({...revised,status:'Diverted'},now).diversion);
 assert.equal(mapAeroFlight({...revised,status:'Not diverted'},now).diversion,undefined);
});
test('arrival at a diversion airport is not presented as the intended destination',()=>{
 const s=story(mapAeroFlight(mergeAeroDiversions([original,revised])[0],now).diversion);
 const step=nextStep(s,now);
 assert.equal(step.title,'Diverted to LAX');
 assert.match(step.body,/Originally bound for HNL/);
 assert.match(step.body,/does not confirm arrival at your intended destination/);
 assert.match(nextStep(s,now+120000).body,/updates are delayed/);
});
test('a destination change emits a diversion alert for the same provider instance',()=>{
 const before=story(undefined,{dest:{icao:'PHNL'},fetchedAt:now-5000});
 const after=story({source:'flightaware',reportedAt:now,originalDestination:'HNL',destination:'LAX'});
 assert.equal(journeyChanges(before,after)[0].kind,'diversion');
 assert.deepEqual(journeyChanges({...before,flightId:'different-day'},after),[]);
});
test('DL307 and DL650 remain separate flights, not inferred rebookings',()=>{
 const onward={...revised,fa_flight_id:'DAL307-test-only',ident:'DAL307',ident_icao:'DAL307',ident_iata:'DL307',origin:airport('LAX','KLAX'),destination:airport('HNL','PHNL')};
 const returning={...onward,fa_flight_id:'DAL650-test-only',ident:'DAL650',ident_icao:'DAL650',ident_iata:'DL650',origin:airport('HNL','PHNL'),destination:airport('JFK','KJFK')};
 assert.equal(selectAeroFlight([onward,returning],'DAL773',now/1000),null);
 assert.equal(mapAeroFlight(onward,now).diversion,undefined);
 assert.equal(mapAeroFlight(returning,now).diversion,undefined);
 assert.deepEqual(journeyChanges(story(undefined),story(undefined,{flightId:'DAL307-test-only',callsign:'DAL307',fetchedAt:now+1})),[]);
});
