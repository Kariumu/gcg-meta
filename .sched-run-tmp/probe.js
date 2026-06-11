const https = require('https');
const API='https://api.bandai-tcg-plus.com', G=15;
function f(u){return new Promise((res,rej)=>{https.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
(async()=>{
  // series list
  const p=await f(`${API}/api/user/event/list/params`);
  const all=p.success.event_series_with_game_title_id;
  const jp=all.filter(s=>s.game_title_id===G && !s.event_series_title.includes('[') && !s.event_series_title.includes('Championships26-27 Store'));
  console.log('JP series count:', jp.length);
  // For each series, fetch offset0 (limit1000) and report length + whether offset is respected
  for(const s of jp){
    const sid=s.event_series_id;
    const a=await f(`${API}/api/user/event/list?game_title_id=${G}&event_series_id=${sid}&limit=1000&offset=0`);
    const la=(a.success.event_list||[]).length;
    let note='';
    if(la===1000){
      const b=await f(`${API}/api/user/event/list?game_title_id=${G}&event_series_id=${sid}&limit=1000&offset=1000`);
      const lb=(b.success.event_list||[]).length;
      const idsA=new Set((a.success.event_list||[]).map(e=>e.id));
      const idsB=(b.success.event_list||[]).map(e=>e.id);
      const overlap=idsB.filter(id=>idsA.has(id)).length;
      note=` | offset1000 len=${lb} overlapWithPage0=${overlap}/${idsB.length} ${overlap===idsB.length&&lb>0?'<<< OFFSET IGNORED = INFINITE LOOP RISK':''}`;
    }
    console.log(`series ${sid} "${s.event_series_title.slice(0,30)}": page0 len=${la}${note}`);
    await new Promise(r=>setTimeout(r,300));
  }
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
