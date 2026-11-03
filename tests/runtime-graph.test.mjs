import test from 'node:test'
import assert from 'node:assert/strict'
import {buildRuntimeGraph} from '../dist-electron/shared/runtime-graph.js'
import {RuntimeGraphStore} from '../dist-electron/main/runtime-graph-store.js'

const at='2026-11-03T04:00:00.000Z'
function fixture(){return {id:'11111111-1111-4111-8111-111111111111',title:'核验应用',model:'fixture',systemPrompt:'',createdAt:at,updatedAt:at,messages:[{id:'u1',role:'user',content:'核验应用',createdAt:at}],taskPlan:{taskId:'job-1',workspace:'workspace',updatedAt:at,items:[{id:'a',title:'读取结构',acceptance:'读取实际文件',status:'complete',attempts:1,summary:'已读取',evidenceIds:[],worker:{id:'wa',mode:'read',assignedAt:at,toolCalls:2}},{id:'b',title:'运行核验',parentId:'a',dependsOn:['a'],acceptance:'核验通过',status:'running',attempts:1,summary:'',evidenceIds:[],worker:{id:'wb',mode:'verify',assignedAt:at,toolCalls:1},runtime:{status:'waiting',phase:'verify',waitReason:'approval',updatedAt:at}}]}}}

test('graph preserves actual hierarchy, dependency direction, worker ownership and waiting reasons',()=>{
 const session=fixture(),graph=buildRuntimeGraph(session,true,[{at,activity:{id:'call1',capability:'agent.read_file',args:{path:'x'},workerId:'wb',status:'waiting'}}])
 assert.equal(graph.nodes.filter(node=>node.kind==='worker').length,2)
 assert.equal(graph.nodes.filter(node=>node.kind==='agent').length,3)
 assert.ok(graph.edges.some(edge=>edge.kind==='dependency'&&edge.source==='task:a'&&edge.target==='task:b'))
 assert.ok(graph.edges.some(edge=>edge.kind==='contains'&&edge.source==='task:a'&&edge.target==='task:b'))
 assert.ok(graph.edges.some(edge=>edge.source==='worker:wb'&&edge.target==='tool:worker:wb:agent.read_file'))
 assert.equal(graph.nodes.find(node=>node.id==='worker:wb').status,'waiting')
 assert.ok(graph.nodes.find(node=>node.id==='task:b').metrics.some(metric=>metric.value==='等待授权'))
 const ids=new Set(graph.nodes.map(node=>node.id));assert.equal(ids.size,graph.nodes.length)
 assert.ok(graph.edges.every(edge=>ids.has(edge.source)&&ids.has(edge.target)))
})

test('historical running states are paused, absent workers are not fabricated, and unfinished work is not completed',()=>{
 const session=fixture();session.taskPlan.items[1].runtime.status='running'
 let graph=buildRuntimeGraph(session)
 assert.equal(graph.nodes.find(node=>node.id==='worker:wb').status,'paused')
 delete session.taskPlan.items[1].worker
 graph=buildRuntimeGraph(session)
 assert.equal(graph.nodes.filter(node=>node.kind==='worker').length,1)
 assert.equal(graph.nodes.find(node=>node.id==='task:b').status,'paused')
 assert.equal(graph.edges.some(edge=>edge.activeAt),false)
})

test('live store updates tool transitions, ignores stale requests, survives reopening, and strips large payloads',()=>{
 const store=new RuntimeGraphStore(),session=fixture()
 store.start(session,'run1')
 const activity={id:'call1',capability:'agent.read_file',args:{secret:'not in graph'},workerId:'wb',status:'running',images:[{dataUrl:'large image'}]}
 store.event(session.id,{type:'tool',requestId:'wrong',activity});assert.equal(store.snapshot().events.length,0)
 store.event(session.id,{type:'tool',requestId:'run1',activity})
 store.event(session.id,{type:'tool',requestId:'run1',activity:{...activity,status:'complete',output:'done'}})
 let graph=store.snapshot(session.id)
 assert.equal(graph.active,true);assert.equal(graph.events.length,2)
 assert.equal(graph.nodes.find(node=>node.kind==='tool').status,'complete')
 assert.equal(graph.edges.find(edge=>edge.kind==='calls').returning,true)
 assert.doesNotMatch(JSON.stringify(graph),/not in graph|large image/)
 store.finish(session.id,'wrong');assert.equal(store.snapshot().active,true)
 store.finish(session.id,'run1');graph=store.snapshot(session.id)
 assert.equal(graph.active,false);assert.equal(graph.edges.find(edge=>edge.kind==='calls').activeAt,undefined)
 assert.deepEqual(store.snapshot(session.id),graph)
 store.remove(session.id);assert.equal(store.snapshot().nodes.length,0)
})

test('telemetry is bounded, missing task references do not create dangling edges',()=>{
 const store=new RuntimeGraphStore(),session=fixture();session.taskPlan.items[1].dependsOn.push('missing')
 store.start(session,'run')
 for(let index=0;index<120;index++)store.event(session.id,{type:'tool',requestId:'run',activity:{id:String(index),capability:'agent.lookup',args:{},status:'complete',output:'x'.repeat(5000),workerId:'unknown-worker'}})
 const graph=store.snapshot()
 assert.equal(graph.truncated,true)
 assert.ok(graph.events.length<=60)
 assert.equal(graph.nodes.filter(node=>node.kind==='tool').length,1)
 assert.equal(graph.nodes.find(node=>node.kind==='tool').detail.length,1200)
 const ids=new Set(graph.nodes.map(node=>node.id));assert.ok(graph.edges.every(edge=>ids.has(edge.source)&&ids.has(edge.target)))
})
