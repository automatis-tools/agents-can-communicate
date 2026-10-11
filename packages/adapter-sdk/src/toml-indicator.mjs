import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {scanConfig,unsafe} from './toml-scan.mjs';

const read = async file => readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const equal = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const prefix = (a,b) => b.every((item,i)=>a[i]===item);

// Only the status section's scalar values and string arrays are interpreted.
// Other TOML is scanned lexically and retained byte for byte.
function valueOf(source) {
 let rest=source.trim();
 function take() {
  rest=rest.trimStart();
  const quote=rest[0];
  if(quote==='"'||quote==="'") {
   const delimiter=rest.startsWith(quote.repeat(3))?quote.repeat(3):quote;
   let i=delimiter.length, text='';
   if(delimiter.length===3 && rest[i]==='\n')i++;
   for(;i<rest.length;) {
    if(rest.startsWith(delimiter,i)) {rest=rest.slice(i+delimiter.length);return text;}
    if(quote==='"'&&rest[i]==='\\') {
     const match=/^\\(U[\da-fA-F]{8}|u[\da-fA-F]{4}|[btnfr"\\])/.exec(rest.slice(i));
     if(!match)unsafe('unsupported status string escape');
     const escape=match[1];
     text+=/^[uU]/.test(escape)?String.fromCodePoint(parseInt(escape.slice(1),16))
      :({b:'\b',t:'\t',n:'\n',f:'\f',r:'\r','"':'"','\\':'\\'})[escape];
     i+=match[0].length;
    } else text+=rest[i++];
   }
   unsafe('unclosed status string');
  }
  if(rest[0]==='[') {
   rest=rest.slice(1);const values=[];
   while(!rest.trimStart().startsWith(']')) {
    values.push(take());rest=rest.trimStart();
    if(rest[0]!==',')break;
    rest=rest.slice(1);
   }
   rest=rest.trimStart();if(rest[0]!==']')unsafe('invalid status array');
   rest=rest.slice(1);return values;
  }
  const scalar=/^(true|false|[-+]?\d+(?:\.\d+)?)(?=\s|,|\]|$)/.exec(rest);
  if(!scalar)unsafe('unsupported status value');
  rest=rest.slice(scalar[0].length);
  return scalar[0]==='true'?true:scalar[0]==='false'?false:Number(scalar[0]);
 }
 const result=take();if(rest.trim())unsafe('extra status value');return result;
}

function inspect(source,table) {
 const nodes=scanConfig(source??''), entries={}, settings={};let header=null;
 for(const node of nodes) {
  if(!node.code)continue;
  if(prefix(node.keys,table)&&node.keys.length>table.length+(node.header?0:1))unsafe('nested status declaration');
  if(node.header&&equal(node.keys,table)) {
   if(header||node.array)unsafe('duplicate status table');header=node;continue;
  }
  if(!node.header&&prefix(table,node.keys))unsafe('inline status table');
  if(!node.header&&prefix(node.keys,table)&&node.keys.length===table.length+1) {
   const key=node.keys.at(-1);
   if(entries[key])unsafe('duplicate status key');
   entries[key]=node;settings[key]=valueOf(node.value);
  }
 }
 if(Object.keys(entries).length&&!header)unsafe('use an explicit status table instead of dotted keys');
 return {nodes,entries,settings,header};
}

function edit(source,table,view,replacements) {
 let next=source??'';const patches=[];const additions=[];
 for(const [key,raw] of Object.entries(replacements)) {
  const entry=view.entries[key];
  if(entry)patches.push({start:entry.start,end:entry.end,text:raw??''});
  else if(raw)additions.push(raw);
 }
 if(additions.length) {
  const at=view.header?.end??next.length;
  const separator=at>0&&next[at-1]!=='\n'?'\n':'';
  patches.push({start:at,end:at,text:separator+(view.header?'':`[${table.join('.')}]\n`)+additions.join('')});
 }
 for(const patch of patches.sort((a,b)=>b.start-a.start))next=next.slice(0,patch.start)+patch.text+next.slice(patch.end);
 return next;
}

/** Save only this command's ownership; later user edits win over refresh/removal. */
export async function configureTomlIndicator({file,marker,table,enabled,set,defaults={},dryRun=false}) {
 const source=await read(file),savedText=await read(marker);
 const saved=savedText===null?null:JSON.parse(savedText);
 if(!enabled&&!saved)return [];
 if(saved&&(saved.schemaVersion!==1||!equal(saved.table,table)||typeof saved.installed?.command!=='string'
  ||!Array.isArray(saved.owned)||typeof saved.installedSource!=='string'))unsafe('invalid indicator ownership');
 const view=inspect(source,table);
 if(dryRun)return [];
 if(saved&&view.settings.command!==saved.installed.command) {
  if(!enabled)await rm(marker,{force:true});
  return [];
 }
 if(!enabled) {
  let next;
  if(source===saved.installedSource)next=saved.original;
  else {
   const replacements={};
   for(const key of saved.owned)if(equal(view.settings[key],saved.installed[key]))replacements[key]=saved.raw[key]??null;
   next=edit(source,table,view,replacements);
   if(!saved.hadHeader) {
    const after=inspect(next,table);
    if(after.header&&Object.keys(after.entries).length===0)next=next.slice(0,after.header.start)+next.slice(after.header.end);
   }
  }
  if(next===null)await rm(file,{force:true});else if(next!==source)await writeFile(file,next);
  await rm(marker,{force:true});return [file];
 }
 const previous=saved?.previous??view.settings;
 const values=typeof set==='function'?await set():set;
 const installed={...view.settings,...Object.fromEntries(Object.entries(defaults).filter(([key])=>!Object.hasOwn(view.settings,key))),...values};
 const owned=saved?saved.owned.filter(key=>equal(view.settings[key],saved.installed[key]))
  :Object.keys(installed).filter(key=>!equal(installed[key],previous[key]));
 const changes={};
 for(const key of owned)if(!equal(view.settings[key],installed[key]))changes[key]=`${key} = ${JSON.stringify(installed[key])}\n`;
 const next=edit(source,table,view,changes);
 const record={schemaVersion:1,file,table,previous,installed,owned,
  raw:saved?.raw??Object.fromEntries(Object.entries(view.entries).map(([key,node])=>[key,node.raw])),
  original:saved?saved.original:source,hadHeader:saved?.hadHeader??Boolean(view.header),
  installedSource:saved?.installedSource??next};
 await mkdir(path.dirname(marker),{recursive:true});
 await writeFile(marker,JSON.stringify(record)+'\n',{mode:0o600});
 try {
  if(next!==source){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,next);}
 } catch(error) {
  if(savedText===null)await rm(marker,{force:true});else await writeFile(marker,savedText,{mode:0o600});
  throw error;
 }
 return [file];
}

/** Read current display choices without reclaiming the previous shell program. */
export async function readTomlIndicatorSettings(record) {
 if(typeof record.file!=='string'||!Array.isArray(record.table))return record.previous??{};
 return inspect(await read(record.file),record.table).settings;
}
