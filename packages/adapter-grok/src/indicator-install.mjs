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
 const supported=typeof context.clientVersion==='string'
  &&compareVersionOrder(versionOrder(context.clientVersion),versionOrder(grokIndicator.minimumVersion))>=0;
 if(enabled&&!supported)return [];
 return configureTomlIndicator({...paths,table:['ui','status_line'],enabled,set:async()=>({type:'command',command:enabled?await indicatorCommand({context,adapterId:'grok',...paths,shell:'portable'}):''}),defaults:{refresh_interval:1}});
}

export const preflightGrokIndicator = context => configureTomlIndicator({...grokIndicatorPaths(context),table:['ui','status_line'],enabled:false,dryRun:true});
