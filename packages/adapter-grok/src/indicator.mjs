import {indicatorGlyph,footerText} from '@agents-can-communicate/adapter-sdk';

export const grokIndicator = {
 minimumVersion:'1.0.46', reload:'start a new Grok session',
 nativeSessionId: payload=>payload.session_id,
 renderText:indicatorGlyph,
 composeText({payload={},indicator,previous='',settings={}}) {
  const cwd=footerText(payload.workspace?.current_dir??payload.cwd).split(/[\\/]/).filter(Boolean).at(-1);
  const percent=payload.context_window?.used_percentage;
  const cost=payload.cost?.total_cost_usd;
  const started=payload.turn?.started_at_ms;
  const elapsed=Number.isFinite(started)?Date.now()-started:NaN;
  const slots={cwd,model:footerText(payload.model?.display_name??payload.model?.id),
   context:Number.isFinite(percent)?`${Math.round(percent)}% ctx`:'',
   cost:Number.isFinite(cost)&&cost>=0.005?`$${cost.toFixed(2)}`:'',
   'turn-timer':Number.isFinite(elapsed)&&elapsed>=1000?`${Math.floor(elapsed/1000)}s`:'',
   'session-name':footerText(payload.session_name)};
  const items=Array.isArray(settings.items)?settings.items:['cwd','model','context'];
  const base=previous.trimEnd() || items.map(id=>slots[id]).filter(Boolean).join(' │ ');
  const [first,...rest]=base.split(/\r?\n/);
  return [[indicator,first].filter(Boolean).join(' │ '),...rest].join('\n');
 },
};
