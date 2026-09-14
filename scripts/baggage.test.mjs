import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBaggage,loadBaggage} from '../src/lib/baggage.server.ts';
const leg={flight:'UA219',origin:'ORD',destination:'HNL',date:'2026-09-13'};
const row=(bag='31')=>`<div role="row" title="UA219 summary"><script>{fn:'219',al:'UA',alname:'United Airlines',depdate:'20260913',deptime:'0925',status:'Arrived',depap:'ORD',depterm:'1',depgate:'B17',arrap:'HNL',arrterm:'2',arrgate:'G3',shares:[]}</script><div role="cell" class="flightValue c11">${bag}</div></div>`;
test('carousel matched to exact flight leg',()=>assert.deepEqual(parseBaggage(row(),leg,123),{status:'posted',carousel:'31',terminal:'2',checkedAt:123}));
test('different day, origin, destination or flight never borrows carousel',()=>{for(const change of [{date:'2026-09-12'},{origin:'SFO'},{destination:'OGG'},{flight:'UA218'}])assert.equal(parseBaggage(row(),{...leg,...change},123).status,'unavailable')});
test('blank carousel is not posted; absent or ambiguous row is unavailable',()=>{assert.equal(parseBaggage(row(''),leg,123).status,'not-posted');assert.equal(parseBaggage('',leg,123).status,'unavailable');assert.equal(parseBaggage(row()+row(),leg,123).status,'unavailable')});
test('unsupported airport does not fetch; upstream error stays isolated',async()=>{const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('offline')};try{assert.equal((await loadBaggage({...leg,destination:'LAX'})).status,'unavailable');assert.equal((await loadBaggage(leg)).status,'unavailable')}finally{globalThis.fetch=original}});
