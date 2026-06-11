const https=require('https');
const API='https://api.bandai-tcg-plus.com';
function f(url){return new Promise((res,rej)=>{const t=Date.now();https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);res({ms:Date.now()-t,bytes:d.length,j});}catch(e){rej(e);}});}).on('error',rej);});}
(async()=>{
  let t=Date.now();
  const p=await f(`${API}/api/user/event/list/params`);
  console.log(`params: ${p.ms}ms ${p.bytes}b`);
  const series=p.j.success.event_series_with_game_title_id.filter(s=>s.game_title_id===15 && !s.event_series_title.includes('[') && !s.event_series_title.includes('Championships26-27 Store'));
  console.log(`JP series: ${series.length}`);
  series.forEach(s=>console.log(`  ${s.event_series_id}: ${s.event_series_title}`));
  // time one page of the big series 7065
  const big=await f(`${API}/api/user/event/list?game_title_id=15&event_series_id=7065&limit=1000&offset=0`);
  console.log(`7065 page0: ${big.ms}ms ${big.bytes}b list=${(big.j.success.event_list||[]).length}`);
  console.log(`TOTAL probe wall: ${Date.now()-t}ms`);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
