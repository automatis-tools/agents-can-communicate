import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultIndicator,shellQuote} from './hook-shim.mjs';
import {windowsHookCommand} from './windows-command.mjs';

export async function indicatorCommand({context,adapterId,marker,shim,shell}) {
 const node=context.node??process.execPath,reader=context.indicatorRunner??defaultIndicator();
 const args=['--adapter',adapterId,'--previous',marker];
 if((context.hostPlatform??process.platform)!=='win32')return [node,reader,...args].map(shellQuote).join(' ');
 // Bake paths as JS data, so no shell expands the marker path or its arguments.
 await mkdir(path.dirname(shim),{recursive:true});
 await writeFile(shim,`import {pathToFileURL} from 'node:url';\nprocess.argv = [process.execPath,${JSON.stringify(reader)},...${JSON.stringify(args)}];\nawait import(pathToFileURL(${JSON.stringify(reader)}).href);\n`);
 return windowsHookCommand(shell,{node,shim,args:[]}).trimEnd();
}
