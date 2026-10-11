import path from 'node:path';
import {configureTomlIndicator,indicatorCommand,compareVersionOrder,versionOrder} from '@agents-can-communicate/adapter-sdk';
import {kimiIndicator} from './indicator.mjs';

export const kimiIndicatorPaths = context => ({
 file:path.join(context.home,'tui.toml'),
 marker:path.join(context.dataHome??context.home,'acc','adapter-kimi','indicator.json'),
 shim:path.join(context.home,'acc','indicator.mjs'),
});
export async function configureKimiIndicator(context,enabled) {
 const paths=kimiIndicatorPaths(context);
 const supported=typeof context.clientVersion==='string'
  &&compareVersionOrder(versionOrder(context.clientVersion),versionOrder(kimiIndicator.minimumVersion))>=0;
 if(enabled&&!supported)return [];
 return configureTomlIndicator({...paths,table:['status_line'],enabled,set:async()=>({command:enabled?await indicatorCommand({context,adapterId:'kimi',...paths,shell:'cmd'}):''})});
}

export const preflightKimiIndicator = context => configureTomlIndicator({...kimiIndicatorPaths(context),table:['status_line'],enabled:false,dryRun:true});
