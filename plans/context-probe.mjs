import { performance } from 'node:perf_hooks';
import { Memory, bytes } from '../src/memory.ts';
import { logMessage, boundedMessage, refreshedRun, refreshPoint, refreshBudget, buildContext } from '../src/transcript.ts';
const noop = () => undefined;
const store = () => ({ load: () => ({ entries: [], tree: [] }), append: noop, appendNode: noop, saveView: noop, putImage: noop, image: noop });
const source = (saved) => ({ directory: 'synthetic-no-files', store: store(), saved });
const timed = (fn, reps = 7) => { const times=[]; let value; for(let i=0;i<reps;i++){const t=performance.now();value=fn();times.push(performance.now()-t);} times.sort((a,b)=>a-b); return {medianMs:+times[Math.floor(reps/2)].toFixed(3),value}; };
const memory = new Memory(source({entries:[],tree:[]}), async x=>'echo: synthetic summary', noop);
const raw = 'h'.repeat(21000)+'DECISIVE_MIDDLE_VALUE'+'t'.repeat(21000);
const result = {role:'toolResult',toolCallId:'a',toolName:'read',content:[{type:'text',text:raw}],isError:false,timestamp:1};
logMessage(memory,boundedMessage(result)); await memory.settle();
console.log(JSON.stringify({case:'oversized-tool-original',sourceChars:raw.length,storedChars:memory.root[0].text.length,middleRecoverableByZoom:memory.zoom(0,1).includes('DECISIVE_MIDDLE_VALUE'),omissionNotice:memory.root[0].text.includes('omitted')})); await memory.close();
const user=(text)=>({role:'user',content:text,timestamp:1});
const reply=(id)=>({role:'assistant',content:[{type:'toolCall',id,name:'read',arguments:{}}],timestamp:1,stopReason:'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},api:'openai-completions',provider:'fixture',model:'fixture'});
const echo=(id,text)=>({...result,toolCallId:id,content:[{type:'text',text}]});
const run=[user('Initial task'),reply('a'),echo('a','x'.repeat(10000)),user('NEW CONSTRAINT: never publish'),reply('b'),echo('b','small')];
const point=refreshPoint(run,0,4000);const refreshed=refreshedRun(run,point.cut,'refresh notice');
console.log(JSON.stringify({case:'live-steering',cut:point.cut,steeringExactInRefreshedRun:JSON.stringify(refreshed).includes('NEW CONSTRAINT: never publish'),initialTaskExact:JSON.stringify(refreshed).includes('Initial task')}));
const budget=refreshBudget(32768,.3);const view='<chat>\n'+'s'.repeat(128000)+'\n</chat>';
const built=buildContext([], [user('tiny task'), reply('c'),echo('c','small')],view,'system');
console.log(JSON.stringify({case:'fixed-view-vs-window',window:32768,refreshRunBudgetChars:budget,viewBytes:bytes(view),requestChars:JSON.stringify(built).length,refreshTriggered:!!refreshPoint([user('tiny task'),reply('c'),echo('c','small')],0,budget),approxTokens:Math.ceil(JSON.stringify(built).length/4),includesSystemToolsCost:false}));
{
 const entries=Array.from({length:256},(_,i)=>({i,kind:'talk',text:'Synthetic full-view entry '+i,date:'2026-01-01T00:00:00Z'}));
 const tree=entries.map((e,i)=>({l:0,i,text:'talk: '+String(i)+' '+ 's'.repeat(484)}));
 const m=new Memory(source({entries,tree,view:JSON.stringify(entries.map((e,i)=>[0,i]))}),async()=>{throw Error('unexpected compression')},noop);
 const render=timed(()=>m.render(),21);
 console.log(JSON.stringify({case:'near-budget-render',viewLines:m.view.length,renderBytes:bytes(render.value),medianMs:render.medianMs})); await m.close();
}
for(const count of [1000,10000,100000]) {
 const entries=Array.from({length:count},(_,i)=>({i,kind:'talk',text:`Synthetic message ${i} `+'payload '.repeat(60)+(i%100===0?' FIND_ME':''),date:'2026-01-01T00:00:00Z'}));
 const tree=[];for(let l=0;2**l<=count;l++)for(let i=0;i<Math.floor(count/2**l);i++) tree.push({l,i,text:'talk: '+String(i)+' synthetic summary '.repeat(4)});
 let at=0;const parts=[];while(at<count){let l=Math.floor(Math.log2(count-at));while(at%2**l)l--;parts.push([l,at/2**l]);at+=2**l;}
 const saved={entries,tree,view:JSON.stringify(parts)};
 const before=process.memoryUsage().heapUsed;const t=performance.now();const m=new Memory(source(saved), async()=>{throw Error('unexpected compression')},noop);const loadMs=performance.now()-t;
 const render=timed(()=>m.render());const cold=timed(()=>{m.clearSearchCache?.();return m.search('FIND_ME').length},1);const warm=timed(()=>m.search('FIND_ME').length);const absent=timed(()=>m.search('DOES_NOT_EXIST').length,1);
 const append=timed(()=>m.append('talk','A new unrelated synthetic reply.'),1);const afterAppend=timed(()=>m.search('FIND_ME').length,1);
 console.log(JSON.stringify({case:'scale',messages:count,nodes:tree.length,viewLines:m.view.length,loadMs:+loadMs.toFixed(2),heapDeltaMB:+((process.memoryUsage().heapUsed-before)/1048576).toFixed(2),renderMs:render.medianMs,renderBytes:bytes(render.value),coldSearchMs:cold.medianMs,warmSearchMs:warm.medianMs,absentSearchMs:absent.medianMs,appendMs:append.medianMs,searchAfterAppendMs:afterAppend.medianMs,hits:cold.value}));await m.close();
}
