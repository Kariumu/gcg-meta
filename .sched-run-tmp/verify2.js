const https=require('https');
const API='https://api.bandai-tcg-plus.com';
function f(u){return new Promise((res,rej)=>{https.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
(async()=>{
  const u0=`${API}/api/user/event/list?game_title_id=15&event_series_id=72&limit=1000&offset=0`;
  const u1=`${API}/api/user/event/list?game_title_id=15&event_series_id=72&limit=1000&offset=1000`;
  const a=(await f(u0)).success.event_list||[];
  const b=(await f(u1)).success.event_list||[];
  console.log('offset=0    : len='+a.length+' firstId='+(a[0]&&a[0].id)+' lastId='+(a[a.length-1]&&a[a.length-1].id));
  console.log('offset=1000 : len='+b.length+' firstId='+(b[0]&&b[0].id)+' lastId='+(b[b.length-1]&&b[b.length-1].id));
  console.log('SAME_PAGE(offset ignored?)='+(a.length===b.length && a[0]&&b[0] && a[0].id===b[0].id && a[a.length-1].id===b[b.length-1].id));
  // bonus: does a 'page' param behave differently?
  try{
    const p2=(await f(`${API}/api/user/event/list?game_title_id=15&event_series_id=72&limit=1000&page=2`)).success.event_list||[];
    console.log("page=2      : len="+p2.length+' firstId='+(p2[0]&&p2[0].id)+' (differsFromOffset0='+(p2[0]&&a[0]&&p2[0].id!==a[0].id)+')');
  }catch(e){console.log('page=2 test error:',e.message)}
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
