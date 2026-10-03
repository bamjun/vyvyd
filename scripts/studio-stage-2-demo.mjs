// A review fixture authored in this conversation, not a product template.
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const projectId = process.argv[2];
if (!projectId) throw new Error('A review project ID is required.');
const output = path.resolve('artifacts/studio-stage-2');
await mkdir(output, {recursive: true});
const client = new Client({name: 'Codex-stage-2-validation', version: '1.0.0'});
const transport = new StdioClientTransport({command: process.execPath, args: [path.resolve('packages/studio-companion/src/mcp-server.mjs')], stderr: 'pipe'});
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({name, arguments: args}, undefined, {timeout: 180000});
  if (result.isError) throw new Error(result.content[0].text);
  return result;
};
const jsonCall = async (name, args) => JSON.parse((await call(name, args)).content[0].text);
try {
  const project = await jsonCall('studio_read_project', {projectId, includeSource: true});
  process.stdout.write(`MCP read: revision ${project.revision}\n`);
  const image = await readFile('artifacts/studio-proof/baseline-frame-45.png');
  const existingAsset = project.assets.find((asset) => asset.name === '연결 확인 이미지.png');
  const added = existingAsset ? {project, appliedRevision: project.revision} : await jsonCall('studio_add_image', {projectId, expectedRevision: project.revision, requestId: randomUUID(), name: '연결 확인 이미지.png', mimeType: 'image/png', base64: image.toString('base64')});
  const assetId = existingAsset?.id ?? added.project.assets.at(-1).id;
  const registry = [
    {id: 'headline', type: 'text', label: '제목', editable: ['x','y','text','fontSize','color'], defaults: {x: 46, y: 148, text: '아이디어를\n포스터로.', fontSize: 68, color: '#101528'}},
    {id: 'description', type: 'text', label: '설명', editable: ['x','y','text','color'], defaults: {x: 48, y: 326, text: '현재 대화에서 만들고,\nvyvyd에서 이어서 편집하세요.', color: '#4a5166'}},
    {id: 'proof-image', type: 'image', label: '프로젝트 이미지', editable: ['x','y','width','height','assetId','hidden'], defaults: {x: 428, y: 634, width: 88, height: 66, assetId}},
  ];
  const source = `import {Composition, registerRoot, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import '@fontsource/noto-sans-kr/500.css';
import '@fontsource/noto-sans-kr/700.css';
import layerDefinitions from './layers.json';

type Props = {composition:{id:'Poster';width:number;height:number;fps:number;durationInFrames:number};backgroundColor:string;layers:Record<string,Record<string,any>>;assetUrls:Record<string,string>};
const defaults:Props = {composition:{id:'Poster',width:600,height:800,fps:24,durationInFrames:72},backgroundColor:'#f5f4ed',layers:{},assetUrls:{}};
const Poster = (props:Props) => {
  const frame = useCurrentFrame();
  const {width,height} = useVideoConfig();
  const layer = (id:string):any => ({...layerDefinitions.find((entry:any)=>entry.id===id)?.defaults,...props.layers[id]});
  const headline=layer('headline'), description=layer('description'), image=layer('proof-image');
  const reveal=interpolate(frame,[0,12],[18,0],{extrapolateRight:'clamp'});
  return <div style={{position:'absolute',inset:0,background:props.backgroundColor,color:'#101528',fontFamily:'Noto Sans KR',overflow:'hidden'}}>
    <div style={{position:'absolute',inset:24,border:'1px solid #101528',borderRadius:24}} />
    <div style={{position:'absolute',left:48,top:51,fontSize:21,fontWeight:700,letterSpacing:-1}}>vyvyd<span style={{fontSize:11,letterSpacing:1.8,marginLeft:12,fontWeight:500}}>POSTER MAKER</span></div>
    <div style={{position:'absolute',right:48,top:48,width:39,height:39,borderRadius:'50%',background:'#101528',color:'#f5f4ed',display:'flex',alignItems:'center',justifyContent:'center',fontSize:13}}>02</div>
    <div style={{position:'absolute',left:48,top:108,fontSize:11,letterSpacing:2.5,color:'#697086'}}>FROM CODE TO CANVAS</div>
    <div data-layer-id="headline" style={{position:'absolute',left:headline.x,top:headline.y,whiteSpace:'pre-line',fontSize:headline.fontSize,color:headline.color,fontWeight:700,lineHeight:1.17,letterSpacing:-4,transform:'translateY('+reveal+'px)'}}>{headline.text}</div>
    <div data-layer-id="description" style={{position:'absolute',left:description.x,top:description.y,fontSize:19,lineHeight:1.6,whiteSpace:'pre-line',color:description.color,letterSpacing:-.5}}>{description.text}</div>
    <div style={{position:'absolute',left:48,top:height-352,width:width-96,height:270,borderRadius:20,background:'#101528',overflow:'hidden'}}>
      <svg width="100%" height="100%" viewBox="0 0 504 270" style={{position:'absolute',inset:0}}>
        <g transform={'translate(315 112) rotate('+frame*.55+')'}><circle r="70" fill="#b5ff6f"/><ellipse rx="111" ry="29" fill="none" stroke="#f5f4ed" strokeWidth="1.4" transform="rotate(-30)"/><ellipse rx="111" ry="29" fill="none" stroke="#b5ff6f" strokeWidth="1.4" transform="rotate(32)"/><circle cx="-91" cy="55" r="9" fill="#b5ff6f"/></g>
      </svg>
      <div style={{position:'absolute',left:28,top:26,color:'#a8afc4',fontSize:10,letterSpacing:2}}>YOUR NEXT IDEA</div>
      <div style={{position:'absolute',left:28,bottom:32,color:'#f5f4ed',fontSize:30,fontWeight:700,lineHeight:1.18,letterSpacing:-1}}>대화가<br/>디자인이 되는 곳.</div>
    </div>
    {!image.hidden && props.assetUrls[image.assetId] && <img data-layer-id="proof-image" src={props.assetUrls[image.assetId]} style={{position:'absolute',left:image.x,top:image.y,width:image.width,height:image.height,objectFit:'cover',border:'1px solid #697086',borderRadius:6}} />}
    <div style={{position:'absolute',left:48,bottom:42,fontSize:10,letterSpacing:1.2,color:'#697086'}}>LOCAL WORKSPACE · FREE REMOTION SOURCE</div>
    <div style={{position:'absolute',right:48,bottom:40,fontSize:11,fontWeight:700}}>MAKE IT YOURS ↗</div>
  </div>;
};
const Root=()=> <Composition id="Poster" component={Poster} {...defaults.composition} defaultProps={defaults} calculateMetadata={({props})=>({...props.composition,props})}/>;
registerRoot(Root);
`;
  const args = {projectId, expectedRevision: added.appliedRevision, requestId: randomUUID(), files: {'src/Root.tsx': source, 'src/layers.json': JSON.stringify(registry,null,2)}, backgroundColor: '#f5f4ed'};
  const applied = await jsonCall('studio_apply_source', args);
  process.stdout.write(`MCP source applied: revision ${applied.appliedRevision}\n`);
  const preview = await call('studio_preview', {projectId, frame: 36});
  const png = Buffer.from(preview.content.find((part)=>part.type==='image').data,'base64');
  await writeFile(path.join(output,'codex-authored.png'),png);
  const repeated = await jsonCall('studio_apply_source', args);
  if (!repeated.replayed) throw new Error('Duplicate request did not replay.');
  await writeFile(path.join(output,'validation.json'),JSON.stringify({projectId,firstRevision:project.revision,appliedRevision:applied.appliedRevision,previewUrl:applied.compile.previewUrl,assetId,requestId:args.requestId,replayed:repeated.replayed,image:{bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')},via:'MCP SDK stdio client from current Codex task; desktop tool catalog reconnection still pending'},null,2));
  process.stdout.write(`PNG verified: ${png.length} bytes; duplicate request replayed\n`);
} finally {await client.close();}
