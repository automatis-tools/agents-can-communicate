import { existsSync } from "node:fs";
import path from 'node:path';
import {configureTomlIndicator,indicatorCommand,compareVersionOrder,versionOrder} from '@agents-can-communicate/adapter-sdk';
import {grokIndicator} from './indicator.mjs';

export const grokIndicatorPaths = context => {
 const root=context.grokHome??path.join(context.home,'.grok');
 return {file:path.join(root,'config.toml'),marker:path.join(context.dataHome??root,'acc','adapter-grok','indicator.json'),
  shim:path.join(root,'hooks','acc-indicator.mjs')};
};
export async function configureGrokIndicator(context,enabled) {
 const paths=grokIndicatorPaths(context);

 if(enabled&&!supportsGrokIndicator(context))return [];
 return configureTomlIndicator({...paths,table:['ui','status_line'],enabled,set:async()=>({type:'command',command:enabled?await indicatorCommand({context,adapterId:'grok',...paths,shell:'portable'}):''}),defaults:{refresh_interval:1}});
}

export const preflightGrokIndicator = context => configureTomlIndicator({...grokIndicatorPaths(context),table:['ui','status_line'],enabled:false,dryRun:true});

function supportsGrokIndicator(context) {
 return typeof context.clientVersion === "string"
  && compareVersionOrder(versionOrder(context.clientVersion), versionOrder(grokIndicator.minimumVersion)) >= 0;
}

export function planGrokIndicator(context) {
 const paths = grokIndicatorPaths(context);
 if (context.indicator === "on" ? !supportsGrokIndicator(context) : !existsSync(paths.marker)) return [];
 return [{path: paths.file, kind: "merge"},
  ...(context.indicator === "on" && context.hostPlatform === "win32" ? [{path: paths.shim, kind: "tree"}] : [])];
}
