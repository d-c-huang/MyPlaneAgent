import * as THREE from 'three'
import {OrbitControls} from 'three/addons/controls/OrbitControls.js'
import {CSS2DObject,CSS2DRenderer} from 'three/addons/renderers/CSS2DRenderer.js'
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js'
import {Line2} from 'three/addons/lines/Line2.js'
import {LineGeometry} from 'three/addons/lines/LineGeometry.js'
import {LineMaterial} from 'three/addons/lines/LineMaterial.js'
import {runtimeStatusColors,runtimeStatusLabels,type RuntimeGraphNode,type RuntimeGraphEdge} from '../../electron/shared/runtime-graph'
import {RuntimeGraphModels,type RuntimeNodeModel} from './runtimeGraphModels'
import {layoutRuntimeGraph} from './runtimeGraphLayout'

type Actor={node:RuntimeGraphNode;group:THREE.Group;model:RuntimeNodeModel;label:CSS2DObject;base:THREE.Vector3;labelSignature:string}
type Connection={edge:RuntimeGraphEdge;line:Line2;arrow:THREE.Mesh<THREE.ConeGeometry,THREE.MeshBasicMaterial>;dot:THREE.Mesh<THREE.SphereGeometry,THREE.MeshBasicMaterial>;curve:THREE.CubicBezierCurve3;path:string}

/** One window owns its scene. Status updates reuse meshes, paths and GPU buffers. */
export class RuntimeGraphScene {
 private readonly scene=new THREE.Scene()
 private readonly camera=new THREE.PerspectiveCamera(38,1,.1,2500)
 private readonly renderer:THREE.WebGLRenderer
 private readonly labels=new CSS2DRenderer()
 private readonly controls:OrbitControls
 private readonly actors=new Map<string,Actor>()
 private readonly connections=new Map<string,Connection>()
 private readonly models=new RuntimeGraphModels()
 private readonly geometries={arrow:new THREE.ConeGeometry(.10,.29,12),dot:new THREE.SphereGeometry(.095,12,8)}
 private readonly observer:ResizeObserver
 private readonly raycaster=new THREE.Raycaster()
 private readonly pointerVector=new THREE.Vector2()
 private readonly projected=new THREE.Vector3()
 private readonly motion=window.matchMedia('(prefers-reduced-motion: reduce)')
 private selected=''
 private hovered=''
 private relatedOnly=false
 private paused=false
 private frame=0
 private disposed=false
 private lost=false
 private dirty=true
 private pointer={x:0,y:0}
 private hoverPointer?:{x:number;y:number}
 private dragging=false
 private lastTime=0
 private animationTime=0
 private lastLabelLayout=0
 private lastStats=0
 private frameCount=0
 private wasAnimating=false
 private highlightUntil=0
 private focusTarget?:{position:THREE.Vector3;target:THREE.Vector3}
 private userMoved=false
 private focusedId=''
 private readonly floor:THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>
 private environment:THREE.WebGLRenderTarget
 constructor(private readonly host:HTMLElement,private readonly select:(id:string)=>void,private readonly onError:(message:string)=>void){
  this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'})
  this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.75));this.renderer.setClearColor('#0b1220',0)
  this.renderer.outputColorSpace=THREE.SRGBColorSpace
  this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05
  this.environment=this.createEnvironment()
  const canvas=this.renderer.domElement
  canvas.setAttribute('aria-label','任务、智能体与 Worker 的三维关系图');canvas.dataset.graphCanvas='true'
  this.labels.domElement.className='runtime-graph-labels'
  this.labels.domElement.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden'
  host.append(canvas,this.labels.domElement)
  this.controls=new OrbitControls(this.camera,canvas)
  this.controls.enableDamping=true;this.controls.dampingFactor=.12;this.controls.minDistance=5;this.controls.maxDistance=2200
  this.controls.minPolarAngle=.08;this.controls.maxPolarAngle=Math.PI*.76
  this.scene.add(new THREE.HemisphereLight('#dcecff','#1b263c',1.1))
  const key=new THREE.DirectionalLight('#edf5ff',2.6);key.position.set(-12,20,18);this.scene.add(key)
  const rim=new THREE.DirectionalLight('#95bce6',2);rim.position.set(12,9,-10);this.scene.add(rim)
  this.floor=new THREE.Mesh(new THREE.PlaneGeometry(1000,1000),new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{},vertexShader:'varying vec2 p;void main(){p=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`
   varying vec2 p;
   void main(){
    vec2 world=(p-.5)*1000.;vec2 cell=world/3.35;
    vec2 line=abs(fract(cell-.5)-.5)/fwidth(cell);
    float grid=1.-min(min(line.x,line.y),1.);
    float fade=1.-smoothstep(12.,105.,length(world));
    float pool=exp(-length(world)*.055);
    gl_FragColor=vec4(mix(vec3(.22,.32,.46),vec3(.32,.46,.58),pool),grid*fade*.13+pool*.018);
   }`}))
  this.floor.rotation.x=-Math.PI/2;this.floor.position.y=-8;this.scene.add(this.floor)
  this.camera.position.set(1,12,45);this.controls.target.set(0,0,0)
  this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(host)
  canvas.addEventListener('pointerdown',this.pointerDown);canvas.addEventListener('pointerup',this.pointerUp)
  canvas.addEventListener('pointermove',this.pointerMove);canvas.addEventListener('pointerleave',this.pointerLeave);canvas.addEventListener('pointercancel',this.pointerLeave)
  canvas.addEventListener('dblclick',this.doubleClick);canvas.addEventListener('webglcontextlost',this.contextLost);canvas.addEventListener('webglcontextrestored',this.contextRestored)
  document.addEventListener('visibilitychange',this.visibility);this.motion.addEventListener('change',this.invalidate)
  this.controls.addEventListener('start',this.cancelFocus);this.controls.addEventListener('change',this.invalidate)
  this.resize();this.invalidate()
 }
 private requestFrame(){if(!this.frame&&!this.disposed&&!this.lost&&!document.hidden)this.frame=requestAnimationFrame(this.tick)}
 private invalidate=()=>{this.dirty=true;this.requestFrame()}
 private createEnvironment(){
  const studio=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(this.renderer)
  try{const target=pmrem.fromScene(studio,.04);this.scene.environment=target.texture;this.scene.environmentIntensity=.85;return target}
  finally{studio.dispose();pmrem.dispose()}
 }
 private cancelFocus=()=>{this.focusTarget=undefined;this.userMoved=true;this.invalidate()}
 private contextLost=(event:Event)=>{event.preventDefault();this.lost=true;cancelAnimationFrame(this.frame);this.frame=0;this.onError('3D 图形上下文已中断，列表与运行记录仍可查看。可点击“重试 3D”。')}
 private contextRestored=()=>{if(!this.disposed){try{this.environment.dispose();this.environment=this.createEnvironment();this.lost=false;this.onError('');this.invalidate()}catch{this.onError('图形环境恢复失败，请点击“重试 3D”重新创建视图。')}}}
 private visibility=()=>{cancelAnimationFrame(this.frame);this.frame=0;if(!document.hidden){this.lastTime=0;this.invalidate()}}
 private pointerDown=(event:PointerEvent)=>{this.pointer={x:event.clientX,y:event.clientY};this.dragging=true;this.hoverPointer=undefined}
 private pointerUp=(event:PointerEvent)=>{
  this.dragging=false
  if(event.button!==0||Math.hypot(event.clientX-this.pointer.x,event.clientY-this.pointer.y)>5)return
  const id=this.pick(event.clientX,event.clientY);if(id)this.select(id)
 }
 private pointerMove=(event:PointerEvent)=>{if(!this.dragging){this.hoverPointer={x:event.clientX,y:event.clientY};this.invalidate()}}
 private pointerLeave=()=>{this.dragging=false;this.hoverPointer=undefined;this.setHovered('')}
 private doubleClick=(event:MouseEvent)=>{const id=this.pick(event.clientX,event.clientY);if(id){this.select(id);this.focus(id)}}
 private pick(x:number,y:number){
  const rect=this.renderer.domElement.getBoundingClientRect()
  if(!rect.width||!rect.height)return ''
  this.pointerVector.set((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1)
  this.raycaster.setFromCamera(this.pointerVector,this.camera)
  const candidates:THREE.Object3D[]=[]
  for(const actor of this.actors.values())if(actor.group.visible){
   candidates.push(...(actor.model.lod.getObjectForDistance(this.camera.position.distanceTo(actor.group.position))?.children||[]))
   // Pick the model surface, not transparent contact shadows or selection rings.
  }
  const hit=this.raycaster.intersectObjects(candidates,true).find(item=>item.object instanceof THREE.Mesh)
  if(!hit)return ''
  let object:THREE.Object3D|null=hit.object
  while(object&&!object.userData.id)object=object.parent
  return object?String(object.userData.id):''
 }
 private setHovered(id:string){
  if(id===this.hovered)return
  this.hovered=id;this.host.dataset.hoveredNode=id;this.renderer.domElement.style.cursor=id?'pointer':'grab';this.highlightUntil=performance.now()+400
  for(const actor of this.actors.values()){actor.model.setHovered(id===actor.node.id);actor.label.element.classList.toggle('hovered',id===actor.node.id)}
  this.styleConnections();this.lastLabelLayout=0;this.invalidate()
 }
 private resize(){
  const width=Math.max(1,this.host.clientWidth),height=Math.max(1,this.host.clientHeight)
  this.renderer.setSize(width,height);this.labels.setSize(width,height);this.camera.aspect=width/height;this.camera.updateProjectionMatrix()
  for(const connection of this.connections.values())connection.line.material.resolution.set(width,height)
  if(this.actors.size&&!this.userMoved)this.frameVisible()
  this.lastLabelLayout=0;this.invalidate()
 }
 update(nodes:RuntimeGraphNode[],edges:RuntimeGraphEdge[],layout:{nodes:RuntimeGraphNode[];edges:RuntimeGraphEdge[]}={nodes,edges}){
  const positions=layoutRuntimeGraph(layout.nodes,layout.edges),ids=new Set(nodes.map(node=>node.id))
  let topologyChanged=nodes.length!==this.actors.size
  for(const [id,actor] of this.actors)if(!ids.has(id)){this.scene.remove(actor.group);actor.label.element.remove();actor.model.dispose();this.actors.delete(id)}
  for(const node of nodes){
   let actor=this.actors.get(node.id)
   if(!actor){
    const group=new THREE.Group(),model=this.models.create(node.kind,node.status)
    model.object.userData.id=node.id;model.object.scale.setScalar(node.kind==='tool'?1:node.id==='agent:coordinator'||node.id==='task:root'?1.24:1.16)
    const element=document.createElement('button');element.type='button';element.className='runtime-node-label';element.dataset.nodeId=node.id
    element.onclick=event=>{event.stopPropagation();this.select(node.id)};element.ondblclick=event=>{event.stopPropagation();this.focus(node.id)}
    element.onpointerenter=()=>this.setHovered(node.id);element.onpointerleave=()=>this.setHovered('')
    element.onfocus=()=>this.setHovered(node.id);element.onblur=()=>this.setHovered('')
    const title=document.createElement('strong'),status=document.createElement('small'),activity=document.createElement('small');activity.className='runtime-node-activity';element.append(title,status,activity)
    const label=new CSS2DObject(element);label.position.set(0,node.kind==='tool'?-1.9:-2.25,.2)
    group.add(model.object,label);this.scene.add(group)
    actor={node,group,model,label,base:new THREE.Vector3(),labelSignature:''};this.actors.set(node.id,actor);topologyChanged=true
   }
   const position=positions.get(node.id)||{x:0,y:0,z:0}
   if(actor.base.distanceToSquared(this.projected.set(position.x,position.y,position.z))>.0001)topologyChanged=true
   actor.node=node;actor.base.set(position.x,position.y,position.z);actor.group.position.copy(actor.base)
   const signature=JSON.stringify([node.label,node.status,node.activity,node.detail,node.pauseRequested,node.configRevision])
   if(signature!==actor.labelSignature){
    actor.labelSignature=signature
    const [title,status,activity]=actor.label.element.children
    title!.textContent=node.label;status!.textContent=(node.pauseRequested?'申请暂停':runtimeStatusLabels[node.status])+(node.configRevision?' · v'+node.configRevision:'')
    activity!.textContent=node.activity||node.detail.slice(0,70)
    actor.label.element.title=node.label+' · '+runtimeStatusLabels[node.status]+' · '+(node.activity||'双击查看模型细节')
    actor.label.element.style.setProperty('--node-color',runtimeStatusColors[node.status]);actor.label.element.dataset.status=node.status
    actor.model.setActivity(node.activity||runtimeStatusLabels[node.status])
   }
  }
  const edgeIds=new Set(edges.map(edge=>edge.id))
  for(const [id,connection] of this.connections)if(!edgeIds.has(id)||!this.actors.has(connection.edge.source)||!this.actors.has(connection.edge.target)){this.disposeConnection(connection);this.connections.delete(id)}
  for(const edge of edges){
   const source=this.actors.get(edge.source),target=this.actors.get(edge.target);if(!source||!target)continue
   let connection=this.connections.get(edge.id)
   if(!connection){
    const material=new LineMaterial({transparent:true,depthWrite:false,dashSize:.24,gapSize:.24,worldUnits:false})
    material.resolution.set(this.host.clientWidth,this.host.clientHeight)
    const line=new Line2(new LineGeometry(),material)
    const arrow=new THREE.Mesh(this.geometries.arrow,new THREE.MeshBasicMaterial({transparent:true,depthWrite:false}))
    const dot=new THREE.Mesh(this.geometries.dot,new THREE.MeshBasicMaterial({color:'#d8fcff',toneMapped:false,depthWrite:false}));dot.visible=false
    connection={edge,line,arrow,dot,curve:new THREE.CubicBezierCurve3(),path:''};this.connections.set(edge.id,connection);this.scene.add(line,arrow,dot)
   }
   connection.edge=edge
   const path=[...source.base.toArray(),...target.base.toArray(),edge.kind].join(',')
   if(connection.path!==path){
    connection.path=path;const dependency=edge.kind==='dependency',start=source.base.clone(),end=target.base.clone()
    const descending=Math.abs(end.y-start.y)>Math.abs(end.x-start.x)*1.5
    if(dependency){start.x-=.65;end.x-=.65;start.z-=.6;end.z-=.6}
    else if(descending){start.y-=1.1;end.y+=1.15}
    else{const direction=Math.sign(end.x-start.x)||1;start.x+=1.3*direction;end.x-=1.3*direction;start.y-=.55;end.y-=.55}
    const distance=Math.abs(end.x-start.x),curve=connection.curve
    curve.v0.copy(start);curve.v3.copy(end)
    curve.v1.copy(start).add(new THREE.Vector3(dependency?-1.9:descending?0:(end.x-start.x)*.4,descending?(end.y-start.y)*.4:0,dependency?-1.4:0))
    curve.v2.copy(end).add(new THREE.Vector3(dependency?-1.9:descending?0:-(end.x-start.x)*.4,descending?-(end.y-start.y)*.4:0,dependency?-1.4:0))
    if(edge.kind==='contains'&&distance>24){curve.v1.z-=4;curve.v2.z-=4}
    connection.line.geometry.dispose();connection.line.geometry=new LineGeometry().setPositions(curve.getPoints(distance>20?40:24).flatMap(point=>[point.x,point.y,point.z]));connection.line.computeLineDistances()
    connection.arrow.position.copy(curve.getPoint(.79));connection.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),curve.getTangent(.79).normalize())
   }
   connection.line.material.dashed=edge.kind==='dependency'
   connection.line.material.color.set(edge.kind==='dependency'?'#7289a7':runtimeStatusColors[edge.status]);connection.arrow.material.color.copy(connection.line.material.color)
  }
  if(this.focusedId&&!this.actors.has(this.focusedId)){this.focusedId='';this.userMoved=false;topologyChanged=true}
  this.applyVisibility();this.setSelected(this.selected)
  if(topologyChanged)this.highlightUntil=performance.now()+400
  if(topologyChanged&&!this.userMoved)this.frameVisible()
  this.host.dataset.nodes=String(nodes.length);this.host.dataset.edges=String(this.connections.size)
  this.lastLabelLayout=0;this.invalidate()
 }
 private neighborhood(){
  const related=new Set<string>(this.actors.has(this.selected)?[this.selected]:[])
  for(const {edge} of this.connections.values()){if(edge.source===this.selected)related.add(edge.target);if(edge.target===this.selected)related.add(edge.source)}
  return related
 }
 private applyVisibility(){
  const related=this.neighborhood(),restrict=this.relatedOnly&&related.size>0
  for(const actor of this.actors.values())actor.group.visible=this.focusedId?actor.node.id===this.focusedId:!restrict||related.has(actor.node.id)
  for(const row of this.connections.values()){const visible=!this.focusedId&&!!this.actors.get(row.edge.source)?.group.visible&&!!this.actors.get(row.edge.target)?.group.visible;row.line.visible=visible;row.arrow.visible=visible;if(!visible)row.dot.visible=false}
  this.host.dataset.scope=this.relatedOnly?'related':'all';this.host.dataset.view=this.focusedId?'detail':'overview'
  this.host.dataset.visibleNodes=String([...this.actors.values()].filter(actor=>actor.group.visible).length)
  if(this.hovered&&!this.actors.get(this.hovered)?.group.visible)this.setHovered('')
 }
 private styleConnections(){
  const related=this.neighborhood()
  for(const actor of this.actors.values()){
   const selected=actor.node.id===this.selected
   actor.model.setState(actor.node.status,selected);actor.label.element.classList.toggle('selected',selected)
   actor.label.element.classList.toggle('related',related.has(actor.node.id));actor.label.element.classList.toggle('muted',!!this.selected&&!related.has(actor.node.id))
   actor.label.element.setAttribute('aria-pressed',String(selected))
  }
  for(const row of this.connections.values()){
   const incident=row.edge.source===this.selected||row.edge.target===this.selected,hovered=!!this.hovered&&(row.edge.source===this.hovered||row.edge.target===this.hovered)
   row.line.material.opacity=(incident||hovered)?.84:row.edge.status==='running'?.42:.22
   row.line.material.linewidth=incident||hovered?2:row.edge.kind==='dependency'?1:1.3
   row.arrow.material.opacity=(incident||hovered)?.9:.38
  }
 }
 setSelected(id:string){
  const changed=this.selected!==id;this.selected=id
  if(this.focusedId&&changed){if(this.actors.has(id)){this.focus(id);return}this.focusedId=''}
  this.applyVisibility();this.styleConnections()
  if(changed&&this.relatedOnly&&!this.focusedId)this.frameVisible()
  if(changed){this.highlightUntil=performance.now()+400;this.lastLabelLayout=0;this.invalidate()}
 }
 setRelatedOnly(value:boolean){if(this.relatedOnly===value)return;this.relatedOnly=value;this.focusedId='';this.userMoved=false;this.applyVisibility();this.frameVisible();this.invalidate()}
 focus(id:string,recenter=true){
  const actor=this.actors.get(id);if(!actor)return
  this.userMoved=true;this.focusedId=id;this.applyVisibility()
  this.floor.position.set(actor.base.x,actor.base.y-1.65,actor.base.z)
  if(recenter)this.focusTarget={target:actor.base.clone().add(new THREE.Vector3(0,-.05,0)),position:actor.base.clone().add(new THREE.Vector3(2.7,2.7,9.5))}
  this.lastLabelLayout=0;this.invalidate()
 }
 fit(){this.userMoved=false;this.focusedId='';this.applyVisibility();this.frameVisible();this.invalidate()}
 private frameVisible(){
  const visible=[...this.actors.values()].filter(actor=>actor.group.visible)
  if(!visible.length)return
  const box=new THREE.Box3().setFromPoints(visible.map(actor=>actor.base)),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3())
  // Reserve the overlay header and controls without sacrificing half the viewport.
  const span=Math.max((size.x+5.8)/this.camera.aspect,(size.y+6.6)/.77,9)
  const distance=span/(2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)))
  this.focusTarget={target:center,position:center.clone().add(new THREE.Vector3(.8,distance*.13,distance))}
  this.floor.position.set(center.x,box.min.y-2.15,0)
 }
 setPaused(value:boolean){if(this.paused===value)return;this.paused=value;this.lastStats=0;this.invalidate()}
 private tick=(time:number)=>{
  this.frame=0
  if(this.disposed||this.lost||document.hidden)return
  if(time-this.lastTime<1000/30){this.frame=requestAnimationFrame(this.tick);return}
  const delta=this.lastTime?Math.min(64,time-this.lastTime):33;this.lastTime=time
  if(!this.paused&&!this.motion.matches)this.animationTime+=delta
  if(this.hoverPointer){const pointer=this.hoverPointer;this.hoverPointer=undefined;this.setHovered(this.pick(pointer.x,pointer.y))}
  let moving=false,cameraMoving=!!this.focusTarget
  if(this.focusTarget){
   const alpha=this.motion.matches?1:1-Math.exp(-delta/90)
   this.camera.position.lerp(this.focusTarget.position,alpha);this.controls.target.lerp(this.focusTarget.target,alpha)
   if(this.camera.position.distanceTo(this.focusTarget.position)<.015){this.camera.position.copy(this.focusTarget.position);this.controls.target.copy(this.focusTarget.target);this.focusTarget=undefined}
  }
  for(const actor of this.actors.values())if(actor.group.visible){
   const animate=!this.paused&&!this.motion.matches&&actor.node.status==='running'
   moving ||= animate;actor.model.animate(time,animate)
  }
  for(const row of this.connections.values()){
   const age=row.edge.activeAt?Date.now()-Date.parse(row.edge.activeAt):Infinity
   row.dot.visible=row.line.visible&&!this.paused&&!this.motion.matches&&(row.edge.status==='running'||row.edge.kind==='calls'&&age>=0&&age<2600)
   if(row.dot.visible){moving=true;const phase=(this.animationTime*.00038)%1;row.curve.getPoint(row.edge.returning?1-phase:phase,row.dot.position)}
  }
  const controlsChanged=this.controls.update()
  this.renderer.render(this.scene,this.camera);this.labels.render(this.scene,this.camera);this.frameCount++
  if(this.dirty||cameraMoving||controlsChanged||time-this.lastLabelLayout>250){this.lastLabelLayout=time;this.layoutLabels()}
  if(this.dirty||this.wasAnimating!==moving||time-this.lastStats>1000){this.lastStats=time;this.updateDiagnostics(moving)}
  this.wasAnimating=moving;this.dirty=false
  if(moving||this.focusTarget||controlsChanged||time<this.highlightUntil)this.requestFrame()
 }
 private updateDiagnostics(moving:boolean){
  const {memory,render}=this.renderer.info
  Object.assign(this.host.dataset,{frameCount:String(this.frameCount),geometries:String(memory.geometries),textures:String(memory.textures),drawCalls:String(render.calls),animation:this.paused?'paused':this.motion.matches?'reduced':moving?'running':'idle'})
 }
 private layoutLabels(){
  const accepted:DOMRect[]=[],bounds=this.host.getBoundingClientRect(),rank=(actor:Actor)=>actor.node.id===this.selected?0:actor.node.id===this.hovered?1:['paused','error','waiting'].includes(actor.node.status)?2:actor.node.status==='running'?3:4
  const visible=[...this.actors.values()].filter(actor=>actor.group.visible)
  this.host.dataset.labelDensity=visible.length>22?'compact':'comfortable'
  for(const actor of [...this.actors.values()].sort((a,b)=>rank(a)-rank(b))){
   const element=actor.label.element
   actor.label.getWorldPosition(this.projected);this.projected.project(this.camera)
   if(!actor.group.visible||this.projected.z<-1||this.projected.z>1){element.style.visibility='hidden';element.tabIndex=-1;continue}
   const box=element.getBoundingClientRect(),outside=box.right<bounds.left||box.left>bounds.right||box.bottom<bounds.top+76||box.top>bounds.bottom-68
   const clashes=accepted.some(other=>box.left<other.right+5&&box.right>other.left-5&&box.top<other.bottom+5&&box.bottom>other.top-5)
   const hidden=outside||clashes
   element.style.visibility=hidden?'hidden':'visible';element.tabIndex=hidden?-1:0
   if(!hidden)accepted.push(box)
  }
 }
 private disposeConnection(row:Connection){this.scene.remove(row.line,row.arrow,row.dot);row.line.geometry.dispose();row.line.material.dispose();row.arrow.material.dispose();row.dot.material.dispose()}
 dispose(){
  this.disposed=true;cancelAnimationFrame(this.frame);this.observer.disconnect();document.removeEventListener('visibilitychange',this.visibility);this.motion.removeEventListener('change',this.invalidate)
  const canvas=this.renderer.domElement
  canvas.removeEventListener('pointerdown',this.pointerDown);canvas.removeEventListener('pointerup',this.pointerUp);canvas.removeEventListener('pointermove',this.pointerMove);canvas.removeEventListener('pointerleave',this.pointerLeave);canvas.removeEventListener('pointercancel',this.pointerLeave);canvas.removeEventListener('dblclick',this.doubleClick);canvas.removeEventListener('webglcontextlost',this.contextLost);canvas.removeEventListener('webglcontextrestored',this.contextRestored)
  this.controls.removeEventListener('start',this.cancelFocus);this.controls.removeEventListener('change',this.invalidate);this.controls.dispose()
  for(const row of this.connections.values())this.disposeConnection(row)
  for(const actor of this.actors.values()){actor.label.element.remove();actor.model.dispose()}
  for(const geometry of Object.values(this.geometries))geometry.dispose()
  this.models.dispose();this.environment.dispose();this.floor.geometry.dispose();this.floor.material.dispose()
  this.actors.clear();this.connections.clear();this.scene.clear();this.renderer.dispose();this.renderer.forceContextLoss();canvas.remove();this.labels.domElement.remove()
 }
}
