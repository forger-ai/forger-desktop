import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { WhatsAppRepositoryTransport } = require('../../dist-electron/main/repository-collaboration/whatsapp-transport.js');
const { runRepositoryProcess, buildRepositoryEnvironment } = require('../../dist-electron/main/repository-collaboration/process.js');
const { buildRepositoryPermissionsConfig, validateRepositoryRoots } = require('../../dist-electron/main/repository-collaboration/codex-executor.js');
const { phoneNumberFromJid } = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');

test('transport preserves exact LID membership, paginates groups, serializes sends and retries only explicit throttling', async () => {
  let clock = 0; const sends = []; let attempts = 0;
  const transport = new WhatsAppRepositoryTransport({ call: async (input) => {
    if(input.actionId.endsWith('list_chats')) return {success:true,data:{chats:[{chatId:'g@g.us',title:'Project',chatType:'group'}]}};
    if(input.actionId.endsWith('get_chat_details')) return {success:true,data:{type:'group',metadata:{id:'g@g.us',participants:[{id:'77@lid'},{id:'33@s.whatsapp.net'}]}}};
    attempts++; if(attempts===1) return {success:false,technicalCode:'whatsapp_send_rate_limited'};
    sends.push({at:clock,input}); return {success:true,data:{sent:true,stableMessageRef:Buffer.from(JSON.stringify({remoteJid:'g@g.us',id:`sent-${attempts}`,fromMe:true})).toString('base64url')}};
  }}, {now:()=>clock,sleep:async(ms)=>{clock+=ms;}});
  assert.deepEqual(await transport.listGroups('c'),[{chatId:'g@g.us',title:'Project'}]);
  assert.equal((await transport.listParticipants('c','g@g.us'))[0].participantId,'77@lid');
  assert.equal(phoneNumberFromJid('77@lid'),undefined);
  const results = await Promise.all([transport.sendMessage({connectionId:'c',chatId:'g@g.us',text:'🤖 Forger Uno'}),transport.sendMessage({connectionId:'c',chatId:'g@g.us',text:'🤖 Forger Dos'})]);
  assert.equal(results.length,2); assert.ok(sends[1].at-sends[0].at>1500);
  await assert.rejects(()=>transport.sendMessage({connectionId:'c',chatId:'g@g.us',text:'x'.repeat(4001)}));
});

test('process does not inherit secrets, transports prompt through stdin and honours abort',async()=>{
  const env=buildRepositoryEnvironment({home:tmpdir(),codexHome:tmpdir(),tempRoot:tmpdir(),pathEntries:[]});
  assert.equal(env.OPENAI_API_KEY,undefined); assert.equal(env.GITHUB_TOKEN,undefined);
  const result=await runRepositoryProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{cwd:tmpdir(),env,stdinText:'literal $(not shell)',timeoutMs:5000});
  assert.equal(result.stdout,'literal $(not shell)');assert.equal(result.code,0);
  const controller=new AbortController(); controller.abort();
  await assert.rejects(()=>runRepositoryProcess(process.execPath,[],{cwd:tmpdir(),env,signal:controller.signal}),/cancelled/);
});

test('permissions deny external reads and all command networking; roots reject symlink and external git metadata',async(t)=>{
  const root=await mkdtemp(path.join(tmpdir(),'forger-repo-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo');await mkdir(path.join(repo,'.git'),{recursive:true});
  assert.deepEqual(await validateRepositoryRoots([repo]),[await realpath(repo)]);
  const link=path.join(root,'link');await symlink(repo,link);await assert.rejects(()=>validateRepositoryRoots([link]),/symlink/);
  await rm(path.join(repo,'.git'),{recursive:true});await writeFile(path.join(repo,'.git'),'gitdir: ../outside');
  await assert.rejects(()=>validateRepositoryRoots([repo]),/git_metadata/);
  const config=buildRepositoryPermissionsConfig([repo],path.join(root,'temp'),path.join(root,'home'));
  assert.match(config,/":root" = "deny"/);assert.match(config,/enabled = false/);assert.doesNotMatch(config,/danger-full-access|workspace-write/);
});

test('only persisted live notifications enter collaboration; own human messages use verified socket identity',async()=>{
  const { WhatsAppConnectionManager }=require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
  const saved=[];const delivered=[];const handlers=new Map();
  const root=await mkdtemp(path.join(tmpdir(),'forger-notify-'));
  const store={authDirectory:()=>root,load:async()=>{},upsertMessages:async m=>saved.push(...m),upsertChat:async()=>{},storageStatus:async()=>({})};
  const manager=new WhatsAppConnectionManager(store,async()=>({useMultiFileAuthState:async()=>({state:{creds:{registered:true,me:{id:'33:2@s.whatsapp.net'}}},saveCreds:async()=>{}}),default:()=>({user:{id:'33:2@s.whatsapp.net'},requestPairingCode:async()=> 'code',ev:{on:(e,fn)=>handlers.set(e,fn)}})}));
  const context={metadataRoot:root,onWhatsAppMessage:async m=>{assert.ok(saved.some(x=>x.stableMessageRef.id===m.messageId));delivered.push(m);}};
  try{
    await manager.startPairing(context,{method:'pairing_code',phoneNumber:'56912345678'});
    const message=(id,fromMe=false)=>({key:{remoteJid:'g@g.us',id,fromMe,...(!fromMe?{participant:'77@lid'}:{})},messageTimestamp:100,message:{conversation:'@forger cambia'}});
    handlers.get('messages.upsert')({type:'append',messages:[message('old')]});
    handlers.get('messages.upsert')({type:'notify',messages:[message('live'),message('self',true)]});
    for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));
    assert.deepEqual(delivered.map(x=>x.messageId),['live','self']);assert.equal(delivered[1].senderId,'33@s.whatsapp.net');assert.equal(delivered[1].identityVerified,true);
    await manager.stopListening();handlers.get('messages.upsert')({type:'notify',messages:[message('late')]});
    for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));assert.equal(delivered.length,2);
  }finally{await manager.stopListening();await rm(root,{recursive:true,force:true});}
});

test('process preserves fragmented UTF-8, bounds output, and cancels running children',async()=>{
  const env=buildRepositoryEnvironment({home:tmpdir(),codexHome:tmpdir(),tempRoot:tmpdir(),pathEntries:[]});
  const options={cwd:tmpdir(),env,timeoutMs:3000};
  const utf=await runRepositoryProcess(process.execPath,['-e','const x=Buffer.from("a🌎ñ");let i=0;const t=setInterval(()=>{process.stdout.write(x.subarray(i,i+1));if(++i===x.length)clearInterval(t)},2)'],options);
  assert.equal(utf.stdout,'a🌎ñ');
  await assert.rejects(()=>runRepositoryProcess(process.execPath,['-e','process.stdout.write("x".repeat(5000));setInterval(()=>{},1000)'],{...options,maxOutputBytes:100}),/output_limit/);
  await assert.rejects(()=>runRepositoryProcess(process.execPath,['-e','setInterval(()=>process.stdout.write("x"),5)'],{...options,timeoutMs:80}),/execution_timeout/);
  await assert.rejects(()=>runRepositoryProcess(process.execPath,['-e','console.log("x");setInterval(()=>{},1000)'],{...options,onStdout:()=>{throw Error('callback secret');}}),/callback_failed/);
  const controller=new AbortController();let spawned=false;
  const pending=runRepositoryProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{...options,signal:controller.signal,onChild:()=>{spawned=true;setTimeout(()=>controller.abort(),20);}});
  await assert.rejects(()=>pending,/cancelled/);assert.equal(spawned,true);
});

test('revocation after throttling prevents dispatch and an ambiguous send failure is never retried',async()=>{
  let count=0;let allowed=true;let time=0;
  const transport=new WhatsAppRepositoryTransport({call:async()=>{count++;return {success:true,data:{sent:true,stableMessageRef:Buffer.from(JSON.stringify({remoteJid:'g@g.us',id:'first',fromMe:true})).toString('base64url')}};}},{now:()=>time,sleep:async ms=>{time+=ms;allowed=false;}});
  await transport.sendMessage({connectionId:'c',chatId:'g@g.us',text:'🤖 Forger Uno'});
  await assert.rejects(()=>transport.sendMessage({connectionId:'c',chatId:'g@g.us',text:'🤖 Forger Dos',canSend:async()=>allowed}),/cancelled/);
  assert.equal(count,1);
  const failing=new WhatsAppRepositoryTransport({call:async()=>{count++;throw Error('uncertain');}});
  await assert.rejects(()=>failing.sendMessage({connectionId:'c',chatId:'g@g.us',text:'🤖 Forger retry?'}));assert.equal(count,2);
});

test('native Codex policy permits only authorized repo data and denies credentials, symlinks and external changes', {skip: process.platform!=='darwin'||!process.env.FORGER_TEST_CODEX_BINARY},async(t)=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'forger-native-policy-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),repo2=path.join(root,'repo2'),home=path.join(root,'home'),auth=path.join(root,'codex'),scratch=path.join(root,'scratch');
  for(const dir of [repo,repo2,home,auth,scratch])await mkdir(dir);
  await mkdir(path.join(repo,'.git'));await mkdir(path.join(repo,'.codex'));await writeFile(path.join(repo,'.git','config'),'git secret');
  await writeFile(path.join(repo,'allowed'),'allowed');await writeFile(path.join(repo2,'second'),'second');await writeFile(path.join(root,'private'),'private');await writeFile(path.join(auth,'auth.json'),'synthetic-credential');
  await symlink(path.join(root,'private'),path.join(repo,'escape'));
  const config=buildRepositoryPermissionsConfig([repo,repo2],scratch,auth);await writeFile(path.join(auth,'config.toml'),config);
  const env=buildRepositoryEnvironment({home,codexHome:auth,tempRoot:scratch,pathEntries:[]});
  const {repositoryPolicyArgs}=require('../../dist-electron/main/repository-collaboration/codex-executor.js');
  const flags=repositoryPolicyArgs([repo,repo2],scratch,auth);
  const run=(cmd)=>runRepositoryProcess(process.env.FORGER_TEST_CODEX_BINARY,['--strict-config',...flags,'sandbox','-P','forger-repositories','-C',scratch,'--',...cmd],{cwd:scratch,env,timeoutMs:5000});
  assert.equal((await run(['/bin/cat',path.join(repo,'allowed')])).stdout,'allowed');assert.equal((await run(['/bin/cat',path.join(repo2,'second')])).stdout,'second');
  for(const blocked of [path.join(root,'private'),path.join(auth,'auth.json'),path.join(repo,'escape')])assert.notEqual((await run(['/bin/cat',blocked])).code,0);
  const write=(target)=>run(['/bin/sh','-c','printf changed > "$1"','sh',target]);
  assert.equal((await write(path.join(repo,'new'))).code,0);assert.equal((await write(path.join(repo2,'new'))).code,0);
  assert.notEqual((await write(path.join(root,'private'))).code,0);assert.notEqual((await write(path.join(repo,'.git','config'))).code,0);
  const original=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-secret';
  try {const result=await run(['/usr/bin/env']);assert.doesNotMatch(result.stdout,/synthetic-secret/);} finally {if(original===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=original;}
});

test('executor starts and resumes only its own scoped conversation with identical confined policy and no retries',async(t)=>{
  const {RepositoryCodexExecutor}=require('../../dist-electron/main/repository-collaboration/codex-executor.js');
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'forger-executor-contract-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),repo2=path.join(root,'repo2'),source=path.join(root,'oauth');
  for(const directory of [path.join(repo,'.git'),path.join(repo2,'.git'),source])await mkdir(directory,{recursive:true});await writeFile(path.join(source,'auth.json'),'synthetic');
  const calls=[];let fail=false;
  const executor=new RepositoryCodexExecutor({root:path.join(root,'runtime'),sourceCodexHome:()=>source,platform:'darwin',resolveRuntime:async()=>({cliPath:'/usr/bin/true',pathEntries:[],model:'gpt-5.4',effort:'medium',authenticated:true}),runProcess:async(command,args,options)=>{
    if(args.includes('--version'))return {code:0,stdout:'codex-cli 0.144.1\n',stderr:''};
    calls.push({command,args,options});
    return {code:fail?1:0,stdout:[{type:'thread.started',thread_id:'own-thread'},{type:'item.completed',item:{type:'agent_message',text:'Listo'}}].map(JSON.stringify).join('\n'),stderr:''};
  }});
  const task={id:'task1',groupId:'group',participantId:'alice'};
  const input={task,prompt:'literal $(do not execute)',repositories:[{id:'r',groupId:'group',name:'web',root:repo}],signal:new AbortController().signal};
  const result=await executor.run(input);assert.equal(result.conversationId,'own-thread');
  await executor.run({...input,task:{...task,id:'task2',participantId:'bob'},conversationId:'own-thread'});
  assert.equal(calls.length,2);assert.ok(calls[1].args.includes('resume'));assert.equal(calls[0].options.env.CODEX_HOME,calls[1].options.env.CODEX_HOME);
  for(const call of calls){assert.ok(call.args.includes('--strict-config'));assert.ok(call.args.includes('--ignore-user-config'));assert.ok(call.args.includes('--ignore-rules'));assert.ok(!call.args.includes('--sandbox'));assert.ok(!call.args.includes('--add-dir'));assert.ok(!call.args.join(' ').includes('bypass'));assert.ok(!call.options.cwd.startsWith(repo));assert.match(call.options.stdinText,/literal \$\(do not execute\)/);assert.equal(call.options.env.OPENAI_API_KEY,undefined);}
  await assert.rejects(()=>executor.run({...input,conversationId:'foreign'}),/conversation_invalid/);
  await assert.rejects(()=>executor.run({...input,repositories:[{id:'r2',groupId:'group',name:'api',root:repo2}],conversationId:'own-thread'}),/conversation_invalid/);
  fail=true;await assert.rejects(()=>executor.run({...input,conversationId:'own-thread'}),/execution_failed/);assert.equal(calls.length,3);
});
