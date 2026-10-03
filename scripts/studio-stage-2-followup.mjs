import {randomUUID, createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const [projectId, mode] = process.argv.slice(2);
if (!projectId || !['edits','invalid','source'].includes(mode)) throw new Error('Provide review project ID and edits|invalid|source.');
const client = new Client({name:'Codex-stage-2-validation',version:'1.0.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('packages/studio-companion/src/mcp-server.mjs')],stderr:'pipe'}));
const call = (name,args) => client.callTool({name,arguments:args},undefined,{timeout:180000});
const checked = async (name,args) => {
  const result = await call(name,args);
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
try {
  const project = await checked('studio_read_project',{projectId,includeSource:true});
  const before = await checked('studio_get_status',{projectId});
  const envelope = {projectId,expectedRevision:project.revision,requestId:randomUUID()};
  let outcome;
  if (mode === 'edits') outcome = await checked('studio_update_edits',{...envelope,layerEdits:{headline:{text:'대화에서\n완성까지.'},description:{text:'문구 수정도 같은 대화에서.\n프로젝트 상태는 그대로 이어집니다.'}}});
  else if (mode === 'invalid') {
    const result = await call('studio_apply_source',{...envelope,files:{'src/Root.tsx':'export const Broken = () => <div>'}});
    if (!result.isError) throw new Error('Invalid source was accepted.');
    const after = await checked('studio_read_project',{projectId,includeSource:true});
    const status = await checked('studio_get_status',{projectId});
    if (after.revision !== project.revision || after.source.files['src/Root.tsx'] !== project.source.files['src/Root.tsx'] || status.compile.previewUrl !== before.compile.previewUrl) throw new Error('Invalid draft replaced last good project.');
    outcome = {rejected:true,revision:after.revision,message:result.content[0].text,previewPreserved:true};
  } else {
    const source = project.source.files['src/Root.tsx'].replace('YOUR NEXT IDEA','MADE WITH CODEX').replace('frame*.55','frame*.8');
    const latencies=[],failures=[];
    const samples=[];
    const timer=setInterval(()=>{
      const started=Date.now();
      const sample=fetch('http://127.0.0.1:4180/health',{signal:AbortSignal.timeout(5000)}).then((response)=>{if(!response.ok) throw new Error('health response');latencies.push(Date.now()-started);}).catch((cause)=>failures.push(cause.message));
      samples.push(sample);
    },1000);
    try {outcome = await checked('studio_apply_source',{...envelope,files:{'src/Root.tsx':source}});}
    finally {clearInterval(timer);await Promise.allSettled(samples);}
    outcome.serviceDuringCompile={samples:latencies.length,maxMs:Math.max(0,...latencies),failures};
    const result = await call('studio_preview',{projectId,frame:36});
    if(result.isError) throw new Error(result.content[0].text);
    const bytes = Buffer.from(result.content.find((item)=>item.type==='image').data,'base64');
    await writeFile('artifacts/studio-stage-2/codex-followup.png',bytes);
    outcome.image={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  const filename='artifacts/studio-stage-2/validation.json';
  const report=JSON.parse(await readFile(filename,'utf8'));
  report[mode]=outcome;
  await writeFile(filename,JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify({mode,revision:outcome.appliedRevision??outcome.revision,rejected:outcome.rejected,previewPreserved:outcome.previewPreserved,imageBytes:outcome.image?.bytes})+'\n');
} finally {await client.close();}
