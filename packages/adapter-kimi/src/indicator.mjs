import {indicatorGlyph,footerText,footerCwd} from '@agents-can-communicate/adapter-sdk';

export const kimiIndicator = {
 minimumVersion:'2.1.1', reload:'run /reload-tui', budgetMs:180, previousTimeoutMs:80,
 nativeSessionId: payload=>payload.sessionId,
 renderText:indicatorGlyph,
 composeText({payload={},indicator,previous='',settings={}}) {
  const mode=[payload.permissionMode==='auto'?'auto':payload.permissionMode==='yolo'?'yolo':'',
   payload.planMode===true?'plan':''].filter(Boolean).join(' · ');
  const slots={mode,model:footerText(payload.model),cwd:footerCwd(payload.cwd),git:footerText(payload.gitBranch)};
  const items=Array.isArray(settings.items)?settings.items:['mode','model','cwd','git'];
  const base=previous.trimEnd().split(/\r?\n/)[0] || items.map(id=>slots[id]).filter(Boolean).join(' · ');
  // The client has no session until the first prompt. This is not an ACC failure.
  if(payload.sessionId==='')return base;
  return [indicator,base].filter(Boolean).join(' │ ');
 },
};
