// Fixture-only comparison. Usage: node --experimental-strip-types --import
// ./scripts/test-imports.mjs scripts/compare-phase-replays.mjs /absolute/main-worktree
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'vite';
import assert from 'node:assert/strict';
import {runStages,runProjection,captured} from './phase-replays.mjs';
const baseline=resolve(process.argv[2]||'');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:baseline,encoding:'utf8'}).trim(),'3ceca9ab0baf504b68042fdad69cf1e0023eb3c3');
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:baseline,encoding:'utf8'}).trim(),'');
const dir=await mkdtemp(resolve('node_modules/.phase-compare-'));
try {
  const modules=[];
  for(const [label,root] of [['main',baseline],['pr',process.cwd()]]){
    const entry=join(dir,label+'.mjs');
    await writeFile(entry,`export {currentStageOf,isFinalApproach} from ${JSON.stringify(join(root,'src/lib/story.server.ts'))}; export {normalizedToLive} from ${JSON.stringify(join(root,'src/lib/flight-data.ts'))}; export * from ${JSON.stringify(join(root,'src/lib/arrival-projection-state.ts'))};`);
    await build({configFile:false,logLevel:'silent',build:{ssr:entry,outDir:join(dir,label),rollupOptions:{output:{entryFileNames:'out.mjs'}}}});
    modules.push(await import(pathToFileURL(join(dir,label,'out.mjs'))));
  }
  const [main,pr]=modules,oldRows=runStages(main,main.normalizedToLive),newRows=runStages(pr,pr.normalizedToLive);
  const timing=newRows.map((r,i)=>({name:r.name,mainArrivalMinute:oldRows[i].arrivalMinute,prArrivalMinute:r.arrivalMinute,
    arrivalEarlierMinutes:oldRows[i].arrivalMinute==null||r.arrivalMinute==null?null:oldRows[i].arrivalMinute-r.arrivalMinute,
    mainFinalMinute:oldRows[i].finalMinute,prFinalMinute:r.finalMinute,
    finalEarlierMinutes:oldRows[i].finalMinute==null||r.finalMinute==null?null:oldRows[i].finalMinute-r.finalMinute}));
  const projections=['aa662','ual2207'].map(name=>{
    const fixture=captured(name),old=runProjection(main,main.normalizedToLive,main,fixture),current=runProjection(pr,pr.normalizedToLive,pr,fixture);
    assert.deepEqual(current,old,name+' projection states must match main');
    return {name,fixes:current.length,identicalToMain:true,finalCursorNm:current.at(-1).state.cursorNm};
  });
  console.log(JSON.stringify({baseline:'3ceca9a',timing,projections,main:oldRows,pr:newRows},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
