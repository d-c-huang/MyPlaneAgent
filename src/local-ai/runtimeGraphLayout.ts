import type {RuntimeGraphEdge,RuntimeGraphNode} from '../../electron/shared/runtime-graph'

export type RuntimePosition={x:number;y:number;z:number}

/** Lay out the complete graph so type filters never move the remaining objects. */
export function layoutRuntimeGraph(nodes:RuntimeGraphNode[],edges:RuntimeGraphEdge[]):Map<string,RuntimePosition>{
 const result=new Map<string,RuntimePosition>(),byId=new Map(nodes.map(node=>[node.id,node]))
 const orders=[...new Set(nodes.filter(node=>node.lane>0&&node.kind!=='tool').map(node=>node.order))].sort((a,b)=>a-b)
 const groups=new Map<string,RuntimeGraphNode[]>(),owners=new Map<string,string>()
 for(const edge of edges)if(edge.kind==='calls'&&byId.get(edge.target)?.kind==='tool'&&!owners.has(edge.target))owners.set(edge.target,edge.source)
 for(const node of nodes.filter(node=>node.kind==='tool')){
  const owner=owners.get(node.id)||''
  const siblings=groups.get(owner)||[];siblings.push(node);groups.set(owner,siblings)
 }
 for(const siblings of groups.values())siblings.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id))
 const spacing=Math.max(6.8,...[...groups].filter(([id])=>(byId.get(id)?.lane||0)>0).map(([,group])=>Math.min(3,group.length)*3.9+2.4))
 const toolColumns=Math.max(1,...[...groups].filter(([id])=>(byId.get(id)?.lane||0)>0).map(([,group])=>Math.ceil(group.length/3)))
 const bankWidth=26.8+(toolColumns-1)*5.4
 // Long task lists wrap whole execution chains into columns, rather than
 // shrinking a hundred models into a narrow vertical line in the overview.
 const banks=orders.length>8?Math.max(2,Math.ceil(Math.sqrt(orders.length*spacing*1.35/bankWidth))):1
 const rowsPerBank=Math.max(1,Math.ceil(orders.length/banks))
 for(const node of nodes.filter(node=>node.kind!=='tool')){
  const row=Math.max(0,orders.indexOf(node.order)),bank=Math.floor(row/rowsPerBank),y=((rowsPerBank-1)/2-row%rowsPerBank)*spacing
  result.set(node.id,{x:node.lane===-1?-13.4:node.lane===0?-6.7:bank*bankWidth+(node.lane-1)*6.7,y:node.lane<=0?0:y,z:node.lane===2?.35:0})
 }
 const bottom=Math.min(0,...[...result.values()].map(position=>position.y))
 let shelf=0
 for(const [owner,siblings] of groups){
  const parent=result.get(owner),parentNode=byId.get(owner)
  if(parent&&parentNode&&parentNode.lane>0){
   const rows=Math.min(3,siblings.length)
   siblings.forEach((node,index)=>result.set(node.id,{x:parent.x+6.7+Math.floor(index/3)*5.4,y:parent.y+((rows-1)/2-index%3)*3.9,z:0}))
  }else{
   // Coordinator calls have their own shelf; they cannot overlap a worker's tools.
   siblings.forEach((node,index)=>result.set(node.id,{x:(parent?.x??-13.4)+(index%4)*5.4,y:bottom-6.8-shelf-Math.floor(index/4)*5.5,z:0}))
   shelf+=Math.ceil(siblings.length/4)*5.5
  }
 }
 return result
}
