import { existsSync } from "node:fs";
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

 if(enabled&&!supportsKimiIndicator(context))return [];
 return configureTomlIndicator({...paths,table:['status_line'],enabled,set:async()=>({command:enabled?await indicatorCommand({context,adapterId:'kimi',...paths,shell:'cmd'}):''})});
}

export const preflightKimiIndicator = context => configureTomlIndicator({...kimiIndicatorPaths(context),table:['status_line'],enabled:false,dryRun:true});

function supportsKimiIndicator(context) {
 return typeof context.clientVersion === "string"
  && compareVersionOrder(versionOrder(context.clientVersion), versionOrder(kimiIndicator.minimumVersion)) >= 0;
}

export function planKimiIndicator(context) {
 const paths = kimiIndicatorPaths(context);
 if (context.indicator === "on" ? !supportsKimiIndicator(context) : !existsSync(paths.marker)) return [];
 return [{path: paths.file, kind: "merge"},
  ...(context.indicator === "on" && context.hostPlatform === "win32" ? [{path: paths.shim, kind: "tree"}] : [])];
}
