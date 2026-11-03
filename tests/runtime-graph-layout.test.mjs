import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const source=fs.readFileSync(new URL('../src/local-ai/runtimeGraphLayout.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {layoutRuntimeGraph}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'))
const node=(id,kind,lane,order=0)=>({id,kind,lane,order})
const call=(source,target)=>({id:source+target,source,target,kind:'calls'})

test('coordinator calls occupy a separate shelf from worker tools',()=>{
 const nodes=[node('main','agent',-1),node('root','task',0),node('task','task',1),node('agent','agent',2),node('worker','worker',3),node('main-tool','tool',4),node('worker-tool','tool',4)]
 const positions=layoutRuntimeGraph(nodes,[call('main','main-tool'),call('worker','worker-tool')])
 assert.ok(positions.get('main-tool').y<positions.get('worker-tool').y-4)
 assert.ok(positions.get('worker-tool').x>positions.get('worker').x+3)
 assert.equal(new Set([...positions.values()].map(p=>`${p.x},${p.y},${p.z}`)).size,nodes.length)
})

test('status changes and input ordering preserve spatial identity',()=>{
 const nodes=[node('main','agent',-1),node('first','task',1,2),node('last','task',1,90),node('worker','worker',3,90),node('tool1','tool',4,0),node('tool2','tool',4,1)]
 const edges=[call('worker','tool1'),call('worker','tool2')],initial=layoutRuntimeGraph(nodes,edges)
 const updated=layoutRuntimeGraph([...nodes].reverse().map(item=>({...item,status:'running'})),[...edges].reverse())
 for(const item of nodes)assert.deepEqual(updated.get(item.id),initial.get(item.id))
 assert.ok(Math.abs(initial.get('first').y-initial.get('last').y)<15,'sparse source order must not create empty rows')
})

test('dense tool groups retain unique slots and enough room between adjacent tasks',()=>{
 const nodes=[node('main','agent',-1),node('root','task',0)],edges=[]
 for(let row=0;row<20;row++){
  nodes.push(node('task'+row,'task',1,row),node('agent'+row,'agent',2,row),node('worker'+row,'worker',3,row))
  for(let index=0;index<7;index++){const id=`tool${row}-${index}`;nodes.push(node(id,'tool',4,index));edges.push(call('worker'+row,id))}
 }
 const positions=layoutRuntimeGraph(nodes,edges)
 assert.equal(positions.size,nodes.length)
 assert.equal(new Set([...positions.values()].map(p=>`${p.x},${p.y},${p.z}`)).size,nodes.length)
 for(const position of positions.values())assert.ok(Object.values(position).every(Number.isFinite))
 for(let row=1;row<20;row++){
  if(positions.get('worker'+row).x===positions.get('worker'+(row-1)).x){
   const previousBottom=Math.min(...Array.from({length:7},(_,i)=>positions.get(`tool${row-1}-${i}`).y))
   const currentTop=Math.max(...Array.from({length:7},(_,i)=>positions.get(`tool${row}-${i}`).y))
   assert.ok(previousBottom-currentTop>3,'adjacent tool families leave room for models and labels')
  }
  assert.ok(positions.get('worker'+row).x>positions.get('task'+row).x,'each execution chain keeps its direction after wrapping')
 }
 const values=[...positions.values()],width=Math.max(...values.map(p=>p.x))-Math.min(...values.map(p=>p.x)),height=Math.max(...values.map(p=>p.y))-Math.min(...values.map(p=>p.y))
 assert.ok(width/height>1&&width/height<3.5,'dense graphs use the width of the viewport')
})
