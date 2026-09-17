import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBaggage,parseLaxBaggage,parseFlightViewBaggage,parseAlaskaBaggage,loadBaggage} from '../src/lib/baggage.server.ts';
import {parseCiriumBaggage} from '../src/lib/cirium-baggage.server.ts';
import {baggageSummary} from '../src/lib/baggage-copy.ts';

const leg={flight:'UA219',origin:'ORD',destination:'HNL',date:'2026-09-13'};
const row=(bag='31')=>`<div role="row" title="UA219 summary"><script>{fn:'219',al:'UA',alname:'United Airlines',depdate:'20260913',deptime:'0925',status:'Arrived',depap:'ORD',depterm:'1',depgate:'B17',arrap:'HNL',arrterm:'2',arrgate:'G3',shares:[]}</script><div role="cell" class="flightValue c11">${bag}</div></div>`;

test('HNL carousel matched to exact UA219 flight leg',()=>assert.deepEqual(parseBaggage(row(),leg,123),{status:'posted',carousel:'31',terminal:'2',checkedAt:123}));
test('HNL different day, origin, destination or flight never borrows carousel',()=>{for(const change of [{date:'2026-09-12'},{origin:'SFO'},{destination:'OGG'},{flight:'UA218'}])assert.equal(parseBaggage(row(),{...leg,...change},123).status,'unavailable')});
test('HNL blank carousel is not posted; absent or ambiguous row is unavailable',()=>{assert.equal(parseBaggage(row(''),leg,123).status,'not-posted');assert.equal(parseBaggage('',leg,123).status,'unavailable');assert.equal(parseBaggage(row()+row(),leg,123).status,'unavailable')});

const laxLeg={flight:'AA123',origin:'DFW',destination:'LAX',date:'2026-09-16'};
const laxRow=(flight='AA123',carousel='5')=>`<table><tr><td>American Airlines</td><td>${flight}</td><td>DFW</td><td>Arrived</td><td>4</td><td>${carousel}</td></tr></table>`;
test('LAX baggage table matches exact flight and reads terminal/carousel',()=>assert.deepEqual(parseLaxBaggage(laxRow(),laxLeg,456),{status:'posted',carousel:'5',terminal:'4',checkedAt:456}));
test('LAX does not borrow another flight carousel',()=>assert.equal(parseLaxBaggage(laxRow('AA124'),laxLeg,456).status,'unavailable'));
test('LAX ambiguous duplicate rows fail closed',()=>assert.equal(parseLaxBaggage(laxRow()+laxRow(),laxLeg,456).status,'unavailable'));
test('LAX blank carousel is not posted',()=>assert.equal(parseLaxBaggage(laxRow('AA123',''),laxLeg,456).status,'not-posted'));

const flightViewPage=({origin='DFW',destination='ORD',terminal='3',bag='34'}={})=>`<html><body><h1>FLIGHT STATUS</h1><section>Departure Airport | Dallas Fort Worth Intl (${origin}) Scheduled Time: 1:00 PM</section><section>Arrival Airport | Chicago O Hare Intl (${destination}) Scheduled Time: 3:00 PM At Gate Time: 3:10 PM Terminal: ${terminal} Gate: H11B ${bag?`Baggage: ${bag} `:''}More airport info: Arrivals Weather Delays</section><section>Flight Details Aircraft Boeing 737</section></body></html>`;
const ordLeg={flight:'AA1339',origin:'DFW',destination:'ORD',date:'2026-09-16'};
test('FlightView exact ORD arrival supplies terminal and baggage',()=>assert.deepEqual(parseFlightViewBaggage(flightViewPage(),ordLeg,900),{status:'posted',carousel:'34',terminal:'3',checkedAt:900}));
test('FlightView wrong destination fails closed',()=>assert.equal(parseFlightViewBaggage(flightViewPage({destination:'MCO'}),ordLeg,900).status,'unavailable'));
const mdwLeg={flight:'WN1110',origin:'DEN',destination:'MDW',date:'2026-09-16'};
test('FlightView MDW page without baggage stays not-posted',()=>assert.deepEqual(parseFlightViewBaggage(flightViewPage({origin:'DEN',destination:'MDW',terminal:'',bag:''}),mdwLeg,901),{status:'not-posted',checkedAt:901}));
const mcoLeg={flight:'F91952',origin:'DFW',destination:'MCO',date:'2026-09-16'};
test('FlightView MCO arrival supplies carousel',()=>assert.deepEqual(parseFlightViewBaggage(flightViewPage({origin:'DFW',destination:'MCO',terminal:'A',bag:'7'}),mcoLeg,902),{status:'posted',carousel:'7',terminal:'A',checkedAt:902}));

const ciriumPayload={flightStatuses:[{carrierFsCode:'UA',flightNumber:'219',departureAirportFsCode:'ORD',arrivalAirportFsCode:'HNL',airportResources:{arrivalTerminal:'2',baggage:'31'}}]};
test('Cirium exact flight supplies baggage and terminal',()=>assert.deepEqual(parseCiriumBaggage(ciriumPayload,leg,1000),{status:'posted',carousel:'31',terminal:'2',checkedAt:1000,sourceName:'Cirium FlightStats'}));
test('Cirium exact flight without baggage stays not-posted',()=>assert.equal(parseCiriumBaggage({flightStatuses:[{...ciriumPayload.flightStatuses[0],airportResources:{arrivalTerminal:'2'}}]},leg,1001).status,'not-posted'));
test('Cirium wrong route or ambiguous status fails closed',()=>{assert.equal(parseCiriumBaggage({flightStatuses:[{...ciriumPayload.flightStatuses[0],arrivalAirportFsCode:'LAX'}]},leg,1002).status,'unavailable');assert.equal(parseCiriumBaggage({flightStatuses:[...ciriumPayload.flightStatuses,...ciriumPayload.flightStatuses]},leg,1002).status,'unavailable')});

const alaskaLeg={flight:'AS65',origin:'SEA',destination:'ANC',date:'2026-09-16'};
const alaskaPage=(carousel='1')=>`<html><body><h1>Flight status</h1><p>Seattle (SEA)</p><p>Anchorage (ANC)</p><p>Gate D1</p><p>Carousel ${carousel}</p></body></html>`;
test('Alaska anonymous status page supplies carousel for exact route',()=>assert.deepEqual(parseAlaskaBaggage(alaskaPage(),alaskaLeg,789),{status:'posted',carousel:'1',checkedAt:789}));
test('Alaska route mismatch fails closed',()=>assert.equal(parseAlaskaBaggage(alaskaPage(),{...alaskaLeg,destination:'PDX'},789).status,'unavailable'));
test('Alaska multi-segment page with multiple carousel occurrences is ambiguous',()=>assert.equal(parseAlaskaBaggage(alaskaPage()+alaskaPage('3'),alaskaLeg,789).status,'unavailable'));

test('unsupported airport does not fetch; upstream errors stay isolated',async()=>{const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('offline')};try{assert.equal((await loadBaggage({...leg,destination:'ATL'})).status,'unavailable');assert.equal(calls,0);assert.equal((await loadBaggage(leg)).status,'unavailable');assert.equal((await loadBaggage(laxLeg)).status,'unavailable');assert.equal((await loadBaggage(ordLeg)).status,'unavailable');assert.equal((await loadBaggage(mdwLeg)).status,'unavailable');assert.equal((await loadBaggage(mcoLeg)).status,'unavailable');assert.equal((await loadBaggage(alaskaLeg)).status,'unavailable')}finally{globalThis.fetch=original}});
test('collapsed baggage summary never guesses an assignment',()=>{assert.equal(baggageSummary(null),'Not assigned yet');assert.equal(baggageSummary({status:'not-posted',checkedAt:123}),'Not assigned yet');assert.equal(baggageSummary({status:'posted',carousel:'6',checkedAt:123}),'Carousel 6')});
