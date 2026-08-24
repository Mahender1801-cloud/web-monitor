import { chromium } from 'playwright';
const STORE='https://hashtageyewears.com';
const pause=(a,b)=>new Promise(r=>setTimeout(r,Math.round(a+Math.random()*(b-a))));
const firstVisible=async(loc,max=10)=>{const n=Math.min(await loc.count().catch(()=>0),max);
  for(let i=0;i<n;i++){const c=loc.nth(i); if(await c.isVisible().catch(()=>false)) return c;} return null;};

const j=await(await fetch(STORE+'/products.json?limit=30')).json();
const prod=j.products.find(p=>(p.images||[]).length>1)||j.products[0];
const url=STORE+'/products/'+prod.handle;

const b=await chromium.launch({channel:'chrome'});
const c=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',locale:'en-IN'});
const page=await c.newPage(); page.setDefaultTimeout(25000);
await page.goto(url,{waitUntil:'domcontentloaded'}); await pause(2500,3500);
console.log('product:', prod.handle.slice(0,50));

for(let i=0;i<8;i++){await page.mouse.wheel(0,1400).catch(()=>{}); await pause(300,550);}
await pause(1500,2500);
const m=await page.evaluate(()=>{
  const desc=document.querySelector('[class*="description" i], [class*="product__info" i], .rte');
  const words=desc?(desc.innerText||'').trim().split(/\s+/).filter(Boolean).length:0;
  return {videos:document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length,
    descImgs:desc?desc.querySelectorAll('img').length:0,
    blocks:document.querySelectorAll('[class*="rich-text" i], [class*="a-plus" i], [class*="image-with-text" i]').length, words};
});
const rich=m.videos+m.descImgs+m.blocks;
console.log('A+ content ->', rich?'pass':(m.words>120?'warn':'fail'),
  `| ${m.videos} video · ${m.descImgs} desc-img · ${m.blocks} blocks · ${m.words} words`);

const guide=await firstVisible(page.locator('[class*="size-guide" i], [class*="sizeguide" i], [class*="size_chart" i], a:has-text("Size guide"), button:has-text("Size guide"), a:has-text("Size chart"), button:has-text("Size chart")'));
const lens=await page.locator('[class*="lens" i] select, [class*="lens" i] input, [name*="lens" i], [class*="custom" i] select, [class*="addon" i], [class*="upsell-option" i]').count();
let opened=false;
if(guide){ await guide.click({force:true}).catch(()=>{}); await pause(1800,2800);
  opened=(await page.locator('[role="dialog"]:visible, [class*="modal" i]:visible, [class*="drawer" i]:visible, [class*="popup" i]:visible').count())>0;
  await page.keyboard.press('Escape').catch(()=>{}); }
console.log('size guide ->', (guide&&opened)?'pass':(guide||lens)?'warn':'fail',
  `| guide=${!!guide} opened=${opened} lensControls=${lens}`);
await b.close();
