import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

test('both Python writers create nested project directories without shell access',()=>{
 const result=spawnSync(process.env.MYPLANE_PYTHON||(process.platform==='win32'?'python':'python3'),['-c',String.raw`
import importlib.util, pathlib, tempfile, json
for source in ['python/agent_tools_worker.py','skills/agent-tools/engine.py']:
 spec=importlib.util.spec_from_file_location('nested_write_test',source);engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
 with tempfile.TemporaryDirectory() as directory:
  root=pathlib.Path(directory)
  for tool,args in [('write_file',{'path':'project/assets/.gitkeep','content':''}),('apply_patch',{'changes':[{'path':'project/index.html','after':'<title>created</title>'},{'path':'project/css/style.css','after':'body{}'}]})]:
   prepared=engine.prepare_write(root,tool,args)
   assert not (root/'project').exists() or tool=='apply_patch'
   result=json.loads(engine.execute_plan(root,prepared['plan']))
   assert result['changed'] is True
  assert (root/'project/assets').is_dir() and (root/'project/assets/.gitkeep').read_bytes()==b''
  assert (root/'project/index.html').read_text()=='<title>created</title>'
  assert (root/'project/css/style.css').read_text()=='body{}'
  # Public paths still reject Windows separators and parent traversal.
  for invalid in ['project\\escape.txt','../outside.txt']:
   try: engine.prepare_write(root,'write_file',{'path':invalid,'content':'bad'})
   except ValueError: pass
   else: raise AssertionError('invalid external path accepted')
`],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr||result.error?.message)
})

test('both Python plugins skip identical writes without touching metadata, including mixed patches',()=>{
 const result=spawnSync(process.env.MYPLANE_PYTHON||(process.platform==='win32'?'python':'python3'),['-c',String.raw`
import importlib.util, pathlib, tempfile, json
from unittest.mock import patch
for source in ['python/agent_tools_worker.py','skills/agent-tools/engine.py']:
 spec=importlib.util.spec_from_file_location('no_op_test',source);engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
 with tempfile.TemporaryDirectory() as directory:
  root=pathlib.Path(directory);file=root/'a.txt';file.write_bytes(b'A');stamp=file.stat().st_mtime_ns
  for tool,args in [('write_file',{'path':'a.txt','content':'A'}),('replace_text',{'path':'a.txt','oldText':'A','newText':'A'}),('apply_patch',{'changes':[{'path':'a.txt','before':'A','after':'A'}]})]:
   prepared=engine.prepare_write(root,tool,args)
   with patch.object(engine.os,'replace',side_effect=AssertionError('identical write must not replace')):
    result=json.loads(engine.execute_plan(root,prepared['plan']))
   assert result['status']=='unchanged' and result['changed'] is False and result['paths']==[] and result['unchangedPaths']==['a.txt']
   assert file.stat().st_mtime_ns==stamp
  prepared=engine.prepare_write(root,'apply_patch',{'changes':[{'path':'a.txt','before':'A','after':'A'},{'path':'b.txt','after':''}]})
  result=json.loads(engine.execute_plan(root,prepared['plan']))
  assert result['changed'] and result['paths']==['b.txt'] and result['unchangedPaths']==['a.txt']
  assert file.stat().st_mtime_ns==stamp and (root/'b.txt').exists()
`],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr||result.error?.message)
})
test('both Python writers bound permission retries and preserve concurrent edits',()=>{
 const result=spawnSync(process.env.MYPLANE_PYTHON||(process.platform==='win32'?'python':'python3'),['-c',String.raw`
import importlib.util, pathlib, tempfile, os
from unittest.mock import patch
for source in ['python/agent_tools_worker.py','skills/agent-tools/engine.py']:
 spec=importlib.util.spec_from_file_location('engine_test',source); engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
 with tempfile.TemporaryDirectory() as directory:
  root=pathlib.Path(directory);file=root/'interior.js';file.write_text('old')
  plan={'kind':'write','changes':[{'path':'interior.js','expected':engine.sha(b'old'),'after':'new'}]}
  actual=os.replace
  def denied():
   error=PermissionError('access denied');error.winerror=5;return error
  count=[0]
  def transient(a,b):
   count[0]+=1
   if count[0]<3: raise denied()
   actual(a,b)
  with patch.object(engine.os,'replace',side_effect=transient),patch.object(engine.time,'sleep'):
   engine.execute_plan(root,plan)
  assert file.read_text()=='new' and count[0]==3
  file.write_text('old')
  with patch.object(engine.os,'replace',side_effect=denied()) as replace,patch.object(engine.time,'sleep'):
   try: engine.execute_plan(root,plan)
   except ValueError as error: assert '本次尚未替换任何文件' in str(error)
   else: raise AssertionError('permission error ignored')
   assert replace.call_count==3 and file.read_text()=='old'
  def edit(a,b):
   file.write_text('user edit');raise denied()
  with patch.object(engine.os,'replace',side_effect=edit) as replace,patch.object(engine.time,'sleep'):
   try: engine.execute_plan(root,plan)
   except ValueError as error: assert '文件已变化' in str(error)
   else: raise AssertionError('concurrent edit ignored')
   assert replace.call_count==1 and file.read_text()=='user edit'
`],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr||result.error?.message)
})
