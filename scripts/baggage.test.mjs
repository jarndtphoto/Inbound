import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBaggage,parseLaxBaggage,loadBaggage} from '../src/lib/baggage.server.ts';
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

test('unsupported airport does not fetch; upstream errors stay isolated',async()=>{const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('offline')};try{assert.equal((await loadBaggage({...leg,destination:'ATL'})).status,'unavailable');assert.equal(calls,0);assert.equal((await loadBaggage(leg)).status,'unavailable');assert.equal((await loadBaggage(laxLeg)).status,'unavailable')}finally{globalThis.fetch=original}});
test('collapsed baggage summary never guesses an assignment',()=>{assert.equal(baggageSummary(null),'Not assigned yet');assert.equal(baggageSummary({status:'not-posted',checkedAt:123}),'Not assigned yet');assert.equal(baggageSummary({status:'posted',carousel:'6',checkedAt:123}),'Carousel 6')});
