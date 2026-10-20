const { _electron: electron } = require('playwright'); const path=require('path'); const fs=require('fs'); const os=require('os'); const http=require('http');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'bp-'));
  const srv=http.createServer((req,res)=>{ if(req.method==='GET'){res.end(JSON.stringify({models:[{name:'m'}]}));return;} let b='';req.on('data',d=>b+=d);req.on('end',async()=>{res.writeHead(200);const w='lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua '.repeat(6).split(' ');for(let i=0;i<w.length;i++){res.write(JSON.stringify({message:{content:w[i]+' '},done:i===w.length-1})+'\n');await sleep(12);}res.end();});});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r)); fs.writeFileSync(path.join(DATA,'state.json'),JSON.stringify({settings:{ollama_url:'http://127.0.0.1:'+srv.address().port}}));
  const app=await electron.launch({args:[path.resolve('.'),'--no-sandbox'],env:{...process.env,BUDDY_DATA_DIR:DATA}});
  let island; for(let i=0;i<50&&!island;i++){island=app.windows().find(w=>w.url().includes('island.html'));if(!island)await sleep(200);}
  await island.waitForFunction(()=>window.__island&&window.__island.info); await sleep(500);
  await island.evaluate(()=>{window.__frames=[];let last=performance.now();const f=t=>{window.__frames.push(t-last);last=t;requestAnimationFrame(f);};requestAnimationFrame(f);});
  await island.mouse.move(280,20); await sleep(300);
  for(let i=0;i<60;i++){await island.mouse.move(200+i*3,30+i);await sleep(16);}
  await island.click('#input'); await island.keyboard.type('perf'); await island.keyboard.press('Enter');
  await island.waitForFunction(()=>!window.__island.replyLive&&window.__island.reply.length>100,null,{timeout:20000});
  const fr=await island.evaluate(()=>window.__frames);
  const long=fr.filter(x=>x>34).length, avg=fr.reduce((a,b)=>a+b,0)/fr.length;
  console.log(`frames ${fr.length}, avg ${avg.toFixed(1)}ms, >34ms: ${long} (${(100*long/fr.length).toFixed(1)}%), max ${Math.max(...fr).toFixed(0)}ms`);
  await app.close(); srv.close();
})().catch(e=>{console.error(e);process.exit(1);});
