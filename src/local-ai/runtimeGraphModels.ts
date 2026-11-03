import * as THREE from 'three'
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js'
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js'
import {runtimeStatusColors,type RuntimeNodeKind,type RuntimeNodeStatus} from '../../electron/shared/runtime-graph'

type Vec=[number,number,number]
type Surface='porcelain'|'titanium'|'graphite'|'visor'|'inset'|'accent'|'light'
type Parts=Map<Surface,THREE.BufferGeometry[]>
type Assembly=Map<Surface,THREE.BufferGeometry>
type Family={detail:Assembly;distant:Assembly;rotor:Assembly;rotorPosition:Vec}
export type RuntimeNodeModel={
 object:THREE.Group;lod:THREE.LOD
 setActivity:(text:string)=>void
 setState:(status:RuntimeNodeStatus,selected:boolean)=>void
 setHovered:(hovered:boolean)=>void
 animate:(time:number,moving:boolean)=>void
 dispose:()=>void
}

/** Shared, machined assemblies: a close-up and a small-screen silhouette per family. */
export class RuntimeGraphModels {
 private readonly geometry={
  box:new RoundedBoxGeometry(1,1,1,3,.12),sphere:new THREE.SphereGeometry(1,20,12),
  cylinder:new THREE.CylinderGeometry(1,1,1,32),ring:new THREE.TorusGeometry(1,.022,6,48),
  arc:new THREE.TorusGeometry(1,.018,6,16,Math.PI*.32),
  gem:new THREE.IcosahedronGeometry(1,1),
  hex:new THREE.LatheGeometry([new THREE.Vector2(0,-.5),new THREE.Vector2(.79,-.5),new THREE.Vector2(.9,-.36),new THREE.Vector2(.9,.36),new THREE.Vector2(.79,.5),new THREE.Vector2(0,.5)],6),
  gear:this.gearGeometry(),plane:new THREE.PlaneGeometry(1,1),
 }
 private readonly material={
  porcelain:new THREE.MeshPhysicalMaterial({color:'#d5dfe9',metalness:.15,roughness:.35,clearcoat:.45,clearcoatRoughness:.28,envMapIntensity:.8}),
  titanium:new THREE.MeshStandardMaterial({color:'#8b9fb5',metalness:.78,roughness:.36,envMapIntensity:.85}),
  graphite:new THREE.MeshPhysicalMaterial({color:'#182435',metalness:.48,roughness:.4,clearcoat:.3,envMapIntensity:.75}),
  visor:new THREE.MeshPhysicalMaterial({color:'#07121f',metalness:.18,roughness:.19,clearcoat:1,clearcoatRoughness:.12,envMapIntensity:.8}),
  inset:new THREE.MeshStandardMaterial({color:'#4b617b',metalness:.55,roughness:.4}),
 }
 private readonly families=new Map<RuntimeNodeKind,Family>()
 private readonly glyphs=new Map<RuntimeNodeStatus,THREE.BufferGeometry>()
 private readonly glowTexture=this.makeGlow()
 private readonly shadowMaterial=new THREE.MeshBasicMaterial({map:this.glowTexture,color:'#000000',transparent:true,opacity:.48,depthWrite:false,toneMapped:false})
 private readonly selectionGeometry=this.makeSelection()

 private makeGlow(){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=96
  const ctx=canvas.getContext('2d')!,gradient=ctx.createRadialGradient(48,48,0,48,48,48)
  gradient.addColorStop(0,'rgba(255,255,255,.7)');gradient.addColorStop(.32,'rgba(255,255,255,.28)');gradient.addColorStop(1,'rgba(255,255,255,0)')
  ctx.fillStyle=gradient;ctx.fillRect(0,0,96,96)
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture
 }
 private gearGeometry(){
  const shape=new THREE.Shape(),teeth=12
  for(let index=0;index<=teeth*4;index++){
   const angle=index/(teeth*4)*Math.PI*2,radius=index%4===1||index%4===2?.87:.74
   const x=Math.cos(angle)*radius,y=Math.sin(angle)*radius
   if(index===0)shape.moveTo(x,y);else shape.lineTo(x,y)
  }
  const hole=new THREE.Path();hole.absarc(0,0,.45,0,Math.PI*2,true);shape.holes.push(hole)
  const geometry=new THREE.ExtrudeGeometry(shape,{depth:.20,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.025,bevelThickness:.025,curveSegments:24});geometry.center();return geometry
 }
 private add(parts:Parts,surface:Surface,geometry:THREE.BufferGeometry,position:Vec=[0,0,0],scale:Vec=[1,1,1],rotation:Vec=[0,0,0]){
  const transformed=geometry.index?geometry.toNonIndexed():geometry.clone()
  const matrix=new THREE.Matrix4().compose(new THREE.Vector3(...position),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),new THREE.Vector3(...scale))
  transformed.applyMatrix4(matrix)
  const group=parts.get(surface)||[];group.push(transformed);parts.set(surface,group)
 }
 private bake(parts:Parts):Assembly{
  const result:Assembly=new Map()
  for(const [surface,geometries] of parts){
   const geometry=mergeGeometries(geometries)
   for(const source of geometries)source.dispose()
   if(!geometry)throw new Error('无法构建 3D 节点模型')
   geometry.computeBoundingSphere();result.set(surface,geometry)
  }
  return result
 }
 private makeSelection(){
  const parts:Parts=new Map()
  for(let index=0;index<4;index++)this.add(parts,'light',this.geometry.arc,[0,0,0],[1,1,1],[0,0,index*Math.PI/2+.27])
  return this.bake(parts).get('light')!
 }
 private glyph(status:RuntimeNodeStatus){
  const found=this.glyphs.get(status);if(found)return found
  const parts:Parts=new Map(),{box,ring,sphere}=this.geometry
  const line=(x1:number,y1:number,x2:number,y2:number)=>this.add(parts,'light',box,[(x1+x2)/2,(y1+y2)/2,0],[Math.hypot(x2-x1,y2-y1),.13,.07],[0,0,Math.atan2(y2-y1,x2-x1)])
  if(status==='complete'){line(-.6,.02,-.15,-.4);line(-.15,-.4,.61,.43)}
  else if(status==='paused'){line(-.28,-.5,-.28,.5);line(.28,-.5,.28,.5)}
  else if(status==='error'){line(-.45,-.45,.45,.45);line(-.45,.45,.45,-.45)}
  else if(status==='running'){line(-.25,-.5,.42,0);line(.42,0,-.25,.5)}
  else if(status==='waiting'){line(-.44,.48,.44,.48);line(-.44,-.48,.44,-.48);line(-.38,.44,.38,-.44);line(.38,.44,-.38,-.44)}
  else if(status==='cancelled'){this.add(parts,'light',ring,[0,0,0],[.56,.56,.56]);line(-.34,0,.34,0)}
  else if(status==='queued'){this.add(parts,'light',ring,[0,0,0],[.56,.56,.56]);line(0,0,0,.35);line(0,0,.25,-.15)}
  else this.add(parts,'light',sphere,[0,0,0],[.2,.2,.06])
  const geometry=this.bake(parts).get('light')!;this.glyphs.set(status,geometry);return geometry
 }
 private family(kind:RuntimeNodeKind):Family{
  const cached=this.families.get(kind);if(cached)return cached
  const detail:Parts=new Map(),distant:Parts=new Map(),rotor:Parts=new Map()
  const {box,sphere,cylinder,ring,hex,gear,gem}=this.geometry
  const add=this.add.bind(this)
  const base=(parts:Parts)=>{
   // Thin stepped plinth, chamfered edge and an inset status indicator.
   add(parts,'graphite',cylinder,[0,-1.24,0],[1.03,.12,1.03])
   add(parts,'titanium',cylinder,[0,-1.17,0],[.95,.025,.95])
   add(parts,'graphite',cylinder,[0,-1.14,0],[.90,.035,.90])
   add(parts,'accent',ring,[0,-1.238,0],[1.035,1.035,1.035],[Math.PI/2,0,0])
   add(parts,'visor',box,[0,-1.17,.995],[.42,.18,.07])
  }
  base(detail);base(distant)
  let rotorPosition:Vec=[0,0,0]
  if(kind==='task'){
   // A layered document terminal with a recessed glass face and machined clip.
   add(detail,'graphite',box,[.13,.05,-.23],[1.51,1.83,.24],[0,-.08,0])
   add(detail,'titanium',box,[0,0,0],[1.54,1.82,.24])
   add(detail,'porcelain',box,[0,0,.13],[1.46,1.75,.12])
   add(detail,'visor',box,[0,-.02,.205],[1.26,1.47,.045])
   add(detail,'titanium',box,[0,.81,.15],[.52,.18,.18])
   add(detail,'graphite',box,[0,.83,.25],[.32,.075,.025])
   add(detail,'accent',box,[-.51,-.025,.24],[.038,1.15,.018])
   for(let index=0;index<3;index++){
    add(detail,'titanium',box,[-.28,.34-index*.28,.24],[.105,.105,.025])
    add(detail,index===0?'porcelain':'inset',box,[.10,.34-index*.28,.24],[index===2?.43:.61,.045,.025])
    add(detail,'inset',box,[.025,.24-index*.28,.24],[.46,.025,.025])
   }
   add(detail,'graphite',box,[0,-1.0,-.03],[.48,.18,.42])
   add(rotor,'light',box,[0,0,0],[.87,.018,.012]);rotorPosition=[0,-.42,.258]
   add(distant,'porcelain',box,[0,0,0],[1.5,1.8,.3])
   add(distant,'visor',box,[0,-.02,.17],[1.25,1.43,.04])
   add(distant,'light',box,[-.47,0,.2],[.055,1.1,.025])
   for(let index=0;index<3;index++)add(distant,'titanium',box,[.06,.3-index*.3,.20],[.66,.055,.025])
  }else if(kind==='agent'){
   // Compact assistant: soft ceramic shell, separate visor gasket and metal joints.
   add(detail,'graphite',box,[0,-.62,0],[.82,.6,.64])
   add(detail,'porcelain',box,[0,-.56,.08],[.74,.48,.64])
   add(detail,'titanium',cylinder,[0,-.16,0],[.22,.23,.22])
   add(detail,'graphite',box,[0,.47,-.015],[1.63,1.13,1.00])
   add(detail,'porcelain',box,[0,.50,.035],[1.59,1.08,1.03])
   add(detail,'titanium',box,[0,.48,.53],[1.39,.85,.075])
   add(detail,'graphite',box,[0,.48,.575],[1.31,.77,.035])
   add(detail,'visor',box,[0,.49,.60],[1.24,.69,.04])
   for(const side of [-1,1]){
    add(detail,'light',box,[side*.29,.54,.626],[.20,.075,.02])
    add(detail,'titanium',cylinder,[side*.84,.49,0],[.23,.15,.23],[0,0,Math.PI/2])
    add(detail,'graphite',cylinder,[side*.93,.49,0],[.18,.04,.18],[0,0,Math.PI/2])
    add(detail,'accent',cylinder,[side*.96,.49,0],[.10,.022,.10],[0,0,Math.PI/2])
    add(detail,'titanium',sphere,[side*.55,-.43,0],[.16,.16,.17])
    add(detail,'porcelain',box,[side*.60,-.63,.025],[.25,.42,.36],[0,0,side*.11])
    add(detail,'graphite',box,[side*.60,-.86,.025],[.19,.07,.25])
   }
   add(detail,'inset',box,[0,.30,.626],[.23,.023,.012])
   add(detail,'visor',box,[0,-.57,.42],[.37,.13,.026])
   add(detail,'accent',box,[0,-.57,.44],[.21,.035,.014])
   add(detail,'titanium',cylinder,[.35,1.14,-.07],[.025,.22,.025])
   add(detail,'light',sphere,[.35,1.28,-.07],[.07,.07,.07])
   add(distant,'porcelain',box,[0,.47,0],[1.6,1.08,1])
   add(distant,'visor',box,[0,.48,.53],[1.28,.70,.055])
   for(const side of [-1,1])add(distant,'light',box,[side*.29,.53,.57],[.2,.075,.025])
   add(distant,'porcelain',box,[0,-.55,0],[.76,.58,.6])
   add(distant,'graphite',cylinder,[0,-.1,0],[.2,.2,.2])
  }else if(kind==='worker'){
   // A computing cartridge: ceramic protective cage and a visible illuminated core.
   add(detail,'graphite',hex,[0,-.84,0],[.98,.30,.98])
   add(detail,'titanium',hex,[0,-.66,0],[.90,.07,.90])
   add(detail,'porcelain',hex,[0,.67,0],[.98,.22,.98])
   add(detail,'graphite',hex,[0,.82,0],[.90,.10,.90])
   add(detail,'accent',hex,[0,.51,0],[.88,.055,.88])
   add(detail,'visor',cylinder,[0,-.06,0],[.55,1.08,.55])
   for(let index=0;index<6;index++){
    const angle=index/6*Math.PI*2,s=Math.sin(angle),c=Math.cos(angle)
    add(detail,'porcelain',box,[s*.72,-.06,c*.72],[.13,1.13,.15],[0,angle,0])
    add(detail,'light',box,[s*.56,-.07,c*.56],[.055,.67,.025],[0,angle,0])
    add(detail,'titanium',box,[s*.73,-.49,c*.73],[.16,.08,.17],[0,angle,0])
   }
   add(detail,'inset',ring,[0,-.1,0],[.56,.56,.56],[Math.PI/2,0,0])
   add(detail,'titanium',ring,[0,.89,0],[.57,.57,.57],[Math.PI/2,0,0])
   add(detail,'visor',cylinder,[0,.87,0],[.55,.03,.55])
   rotorPosition=[0,.9,0]
   for(let index=0;index<5;index++){const a=index/5*Math.PI*2;add(rotor,'titanium',box,[Math.sin(a)*.28,0,Math.cos(a)*.28],[.11,.035,.34],[0,a+.5,0])}
   add(rotor,'light',cylinder,[0,.01,0],[.12,.035,.12])
   add(distant,'graphite',hex,[0,-.05,0],[.89,1.65,.89])
   for(const y of [-.75,.73])add(distant,'porcelain',hex,[0,y,0],[.98,.2,.98])
   for(let index=0;index<6;index++){const a=index/6*Math.PI*2;add(distant,'light',box,[Math.sin(a)*.78,-.02,Math.cos(a)*.78],[.065,1.05,.04],[0,a,0])}
  }else{
   // Tool head: a fixed core inside a precision gear, suspended on a short stem.
   add(detail,'graphite',cylinder,[0,-.98,-.03],[.13,.28,.13])
   add(detail,'graphite',cylinder,[0,0,-.02],[.53,.25,.53],[Math.PI/2,0,0])
   add(detail,'porcelain',ring,[0,0,.14],[.51,.51,.51])
   add(detail,'light',ring,[0,0,.175],[.42,.42,.42])
   add(detail,'accent',gem,[0,0,.12],[.28,.28,.23],[0,Math.PI/4,0])
   add(rotor,'titanium',gear)
   for(let index=0;index<6;index++){const a=index/6*Math.PI*2;add(rotor,'graphite',cylinder,[Math.cos(a)*.62,Math.sin(a)*.62,.135],[.045,.018,.045],[Math.PI/2,0,0])}
   add(distant,'titanium',gear)
   add(distant,'graphite',cylinder,[0,0,.04],[.47,.20,.47],[Math.PI/2,0,0])
   add(distant,'light',ring,[0,0,.17],[.39,.39,.39])
   add(distant,'accent',gem,[0,0,.16],[.24,.24,.20])
  }
  const family={detail:this.bake(detail),distant:this.bake(distant),rotor:this.bake(rotor),rotorPosition}
  this.families.set(kind,family);return family
 }
 create(kind:RuntimeNodeKind,status:RuntimeNodeStatus):RuntimeNodeModel{
  const object=new THREE.Group(),detail=new THREE.Group(),distant=new THREE.Group(),rotor=new THREE.Group(),lod=new THREE.LOD()
  const accent=new THREE.MeshPhysicalMaterial({color:runtimeStatusColors[status],metalness:.32,roughness:.3,clearcoat:.4,emissive:runtimeStatusColors[status],emissiveIntensity:.10})
  const light=new THREE.MeshBasicMaterial({color:runtimeStatusColors[status],toneMapped:false})
  const selectionMaterial=new THREE.MeshBasicMaterial({color:'#d9f2ff',transparent:true,opacity:0,depthWrite:false,toneMapped:false})
  const auraMaterial=new THREE.SpriteMaterial({map:this.glowTexture,color:runtimeStatusColors[status],transparent:true,opacity:.07,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false})
  const surface={...this.material,accent,light},family=this.family(kind)
  const instantiate=(group:THREE.Group,assembly:Assembly)=>{for(const [name,geometry] of assembly)group.add(new THREE.Mesh(geometry,surface[name]))}
  instantiate(detail,family.detail);instantiate(distant,family.distant);instantiate(rotor,family.rotor)
  rotor.position.set(...family.rotorPosition);detail.add(rotor)
  // Hysteresis prevents shimmer when zooming across the level boundary.
  lod.addLevel(detail,0);lod.addLevel(distant,140,.12);object.add(lod)
  const halo=new THREE.Mesh(this.selectionGeometry,selectionMaterial);halo.rotation.x=-Math.PI/2;halo.position.y=-1.24;halo.scale.setScalar(1.20);object.add(halo)
  const shadow=new THREE.Mesh(this.geometry.plane,this.shadowMaterial);shadow.rotation.x=-Math.PI/2;shadow.position.y=-1.315;shadow.scale.set(3.25,3.25,1);object.add(shadow)
  const aura=new THREE.Sprite(auraMaterial);aura.position.set(0,-.1,-.1);aura.scale.set(2.9,2.9,1);object.add(aura)
  const glyph=new THREE.Mesh(this.glyph(status),light);glyph.position.set(0,-1.17,1.037);glyph.scale.setScalar(.115);object.add(glyph)
  let currentStatus=status,isSelected=false,isHovered=false,highlight=0,lastTime:number|undefined,motion=0,disposed=false
  const updateState=()=>{
   const color=runtimeStatusColors[currentStatus];accent.color.set(color);accent.emissive.set(color);light.color.set(color);auraMaterial.color.set(color)
   glyph.geometry=this.glyph(currentStatus);object.userData.status=currentStatus
  }
  updateState()
  return {object,lod,
   // Labels own text, so hundreds of nodes do not allocate hundreds of canvas textures.
   setActivity:text=>{object.userData.activity=text},
   setState:(state,selected)=>{isSelected=selected;if(state!==currentStatus){currentStatus=state;updateState()}},
   setHovered:hovered=>{isHovered=hovered},
   animate:(time,moving)=>{
    const delta=lastTime===undefined?0:Math.min(.064,Math.max(0,(time-lastTime)/1000));lastTime=time
    const target=isSelected?1:isHovered?.55:0;highlight+=(target-highlight)*Math.min(1,delta*14)
    halo.visible=highlight>.005;halo.material.opacity=highlight*.85;halo.scale.setScalar(1.2+highlight*.035)
    const active=moving&&currentStatus==='running'
    if(active){
     motion+=delta
     if(kind==='worker')rotor.rotation.y+=delta*1.9
     else if(kind==='tool')rotor.rotation.z+=delta*.28
     else if(kind==='task')rotor.position.y=-.12+Math.sin(motion*1.7)*.43
    }
    rotor.visible=kind!=='task'||currentStatus==='running'
    const pulse=active?(Math.sin(motion*2.4)+1)*.5:0
    accent.emissiveIntensity=.08+highlight*.14+pulse*.05
    auraMaterial.opacity=.035+highlight*.10+pulse*.025
   },
   dispose:()=>{if(disposed)return;disposed=true;accent.dispose();light.dispose();selectionMaterial.dispose();auraMaterial.dispose()},
  }
 }
 dispose(){
  for(const family of this.families.values())for(const assembly of [family.detail,family.distant,family.rotor])for(const geometry of assembly.values())geometry.dispose()
  for(const geometry of this.glyphs.values())geometry.dispose()
  for(const geometry of Object.values(this.geometry))geometry.dispose()
  for(const material of Object.values(this.material))material.dispose()
  this.selectionGeometry.dispose();this.shadowMaterial.dispose();this.glowTexture.dispose();this.families.clear();this.glyphs.clear()
 }
}
