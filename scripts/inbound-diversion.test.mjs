import {test} from "node:test";
import assert from "node:assert/strict";
import {findInboundDiversion,inboundDiversionText} from "../src/lib/inbound-diversion.ts";
const records={
  "650":{flightId:"650",ident:"DAL650",iataIdent:"DL650",tail:"N-TEST",inboundFlightId:"307",gateOut:{scheduled:100000}},
  "307":{flightId:"307",ident:"DAL307",iataIdent:"DL307",tail:"NTEST",inboundFlightId:"773",gateOut:{actual:80000}},
  "773":{flightId:"773",ident:"DAL773",iataIdent:"DL773",tail:"NTEST",gateOut:{actual:60000},
    diversion:{source:"flightaware",reportedAt:90000000,originalDestination:"HNL",destination:"LAX"}},
};
test("DL650 carries DL773 diversion through DL307 using dated assigned-aircraft links",async()=>{
 const calls=[];const notice=await findInboundDiversion(records["650"],records["307"],async id=>{calls.push(id);return records[id]??null});
 assert.deepEqual(notice.chain,["DL773","DL307","DL650"]);
 assert.equal(notice.destination,"LAX");assert.equal(notice.flight,"DL773");
 assert.deepEqual(calls,["773"]);assert.match(inboundDiversionText(notice),/does not mean your flight is diverted/);
});
test("direct inbound diversion also displays",async()=>{
 const notice=await findInboundDiversion(records["307"],records["773"],async()=>{throw Error("not needed")});
 assert.deepEqual(notice.chain,["DL773","DL307"]);
});
test("aircraft swap clears the warning",async()=>{
 assert.equal(await findInboundDiversion({...records["650"],tail:"OTHER"},records["307"],async id=>records[id]),undefined);
 assert.equal(await findInboundDiversion(records["650"],{...records["307"],tail:null},async id=>records[id]),undefined);
});
test("wrong dated instance and reversed departures cannot establish history",async()=>{
 assert.equal(await findInboundDiversion(records["650"],null,async()=>({...records["307"],flightId:"another-day"})),undefined);
 assert.equal(await findInboundDiversion(records["650"],{...records["307"],gateOut:{scheduled:110000}},async id=>records[id]),undefined);
 assert.equal(await findInboundDiversion(records["650"],{...records["307"],gateOut:{scheduled:-100000}},async id=>records[id]),undefined);
});
test("provider failure does not fabricate a diversion or fail flight loading",async()=>{
 assert.equal(await findInboundDiversion(records["650"],null,async()=>{throw Error("429")}),undefined);
 assert.equal(await findInboundDiversion(records["650"],null,async()=>null),undefined);
});
test("lookup is bounded at two prior legs and rejects cycles",async()=>{
 const calls=[];const noDiversion={...records["773"],diversion:undefined,inboundFlightId:"older"};
 assert.equal(await findInboundDiversion(records["650"],null,async id=>{calls.push(id);return id==="773"?noDiversion:records[id]}),undefined);
 assert.deepEqual(calls,["307","773"]);
 assert.equal(await findInboundDiversion({...records["650"],inboundFlightId:"650"},null,async()=>{throw Error("cycle fetched")}),undefined);
});
