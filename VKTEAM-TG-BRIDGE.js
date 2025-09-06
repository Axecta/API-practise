/* ============================================================
   UNIVERSAL BRIDGE (VK Teams ⇄ Telegram)
   v2025-09-06  — secure & resilient edition
   ------------------------------------------------------------
   npm i axios form-data dotenv
   cp .env.example .env  # заполните значения
   node bridge.js
============================================================ */

require('dotenv').config();
const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

/* ── ENV & sanity checks ─────────────────────────────────── */
const VK_BOT_TOKEN = process.env.VK_BOT_TOKEN || '';
const VK_API       = (process.env.VK_API || '').replace(/\/+$/,''); // trim trailing /
const SECRET_KEY   = process.env.SECRET_KEY || ''; // опционально: шифрование TG токенов
const DB_FILE      = process.env.STATE_FILE || 'state.json';

if (!VK_BOT_TOKEN || !VK_API) {
  console.error('❌ Set VK_BOT_TOKEN and VK_API in .env');
  process.exit(1);
}

/* ── helpers: redact, sleep, backoff ─────────────────────── */
const redact = (s) => String(s).replace(/[A-Za-z0-9_\-]{24,}/g, '***');
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const rand   = (min,max)=>Math.floor(Math.random()*(max-min+1))+min;

async function withBackoff(fn, {label='req', tries=5, base=500} = {}){
  let attempt=0, lastErr;
  while(attempt < tries){
    try{ return await fn(); }
    catch(e){
      lastErr = e;
      const status = e?.response?.status;
      if(status && status < 500 && status !== 429) throw e; // не ретраим «плохие запросы»
      const delay = Math.min(base * 2**attempt + rand(0,200), 8000);
      console.warn(`⚠️ ${label} failed (try ${attempt+1}/${tries}, status=${status||'n/a'}): ${redact(e.message)} → retry in ${delay}ms`);
      await sleep(delay);
      attempt++;
    }
  }
  throw lastErr;
}

/* ── crypto for TG token at-rest ─────────────────────────── */
const hasCrypto = !!SECRET_KEY;
const key = hasCrypto ? crypto.createHash('sha256').update(SECRET_KEY).digest() : null;

function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }

function encToken(plain){
  if(!hasCrypto) return {token:plain}; // без шифрования
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain,'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    tokenEnc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decToken(obj){
  if(!hasCrypto) return obj.token;
  const iv  = Buffer.from(obj.iv, 'base64');
  const tag = Buffer.from(obj.tag,'base64');
  const enc = Buffer.from(obj.tokenEnc,'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

/* ── state storage (atomic write) ────────────────────────── */
function readJSON(file){
  try{
    if(!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file,'utf8');
    return JSON.parse(raw);
  }catch(e){ console.error('⚠️ state read error:', e.message); return null; }
}
function writeJSONAtomic(file, obj){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/* ── DB schema (secure) ────────────────────────────────────
db = {
  users: {
    [vkId]: {
      tgHash: null | "<sha256>",
      stage: "await_token"|"await_first_msg"|"ready",
      peers: {
        [chatId]: { chatId, name, idx }
      },
      nextIdx: 1,
      selected: null | chatId
    }
  },
  tokens: {
    [tgHash]: {
      polling: false,
      offset: 0,
      // secret fields (two modes):
      // a) no SECRET_KEY: { token: "<plain>" }
      // b) SECRET_KEY set: { tokenEnc, iv, tag }
    }
  }
}
─────────────────────────────────────────────────────────── */
let db = readJSON(DB_FILE);
if(!db) db = { users:{}, tokens:{} };
const save = ()=>writeJSONAtomic(DB_FILE, db);

/* ── in-memory cache of plaintext TG tokens ─────────────── */
const tokCache = new Map(); // tgHash -> plain token
for(const [h,rec] of Object.entries(db.tokens||{})){
  try{ tokCache.set(h, decToken(rec)); }catch{}
}

/* ── utils for user and tokens ───────────────────────────── */
function usr(vkId){
  if(!db.users[vkId]) db.users[vkId] = {
    tgHash:null, stage:'await_token',
    peers:{}, nextIdx:1, selected:null
  };
  return db.users[vkId];
}

function addToken(plainTok){
  const h = sha256(plainTok);
  if(!db.tokens[h]){
    db.tokens[h] = { polling:false, offset:0, ...encToken(plainTok) };
    save();
  }
  tokCache.set(h, plainTok);
  return h;
}

function getTok(h){ return tokCache.get(h); }

/* ── VK API helpers ─────────────────────────────────────── */
const vkSendText = (chatId,text)=>withBackoff(
  ()=>axios.post(`${VK_API}/messages/sendText`,
    new URLSearchParams({ token:VK_BOT_TOKEN, chatId, text }),
    { headers:{'Content-Type':'application/x-www-form-urlencoded'} }),
  {label:'vkSendText'}
);

const vkGetFileInfo = (fileId)=>withBackoff(
  ()=>axios.get(`${VK_API}/files/getinfo`,
    {params:{ token:VK_BOT_TOKEN, fileId }}),
  {label:'vkGetFileInfo'}
);

const vkGetFileBin = (fileId)=>withBackoff(
  ()=>axios.get(`${VK_API}/files/get`,
    {params:{ token:VK_BOT_TOKEN, fileId }, responseType:'arraybuffer', decompress:false}),
  {label:'vkGetFileBin'}
);

const vkSendFile = (chatId, streamOrBuf, filename)=>withBackoff(
  ()=>{
    const f = new FormData();
    f.append('token', VK_BOT_TOKEN);
    f.append('chatId', chatId);
    f.append('file', streamOrBuf, { filename });
    return axios.post(`${VK_API}/messages/sendFile`, f, { headers:f.getHeaders() });
  },
  {label:'vkSendFile'}
);

const ext = (n,m)=>/\.[a-z\d]+$/i.test(n)?n:n+({'image/jpeg':'.jpg','image/png':'.png','video/mp4':'.mp4'}[m]||'');

/* ── RESET ──────────────────────────────────────────────── */
const tgLoops = new Map(); // tgHash -> function ref (poller)
function reset(vkId){
  const u=db.users[vkId]; if(!u) return;
  const h=u.tgHash;
  delete db.users[vkId];
  if(h && !Object.values(db.users).some(x=>x.tgHash===h)){
    if(db.tokens[h]) db.tokens[h].polling=false;
    if(tgLoops.has(h)){ clearImmediate(tgLoops.get(h)); tgLoops.delete(h); }
  }
  save();
}

/* ============================================================
   1) VK LOOP (commands + forward)
============================================================ */
let vkCur=0;
async function pollVK(){
  try{
    const {data} = await withBackoff(
      ()=>axios.get(`${VK_API}/events/get`, { params:{ token:VK_BOT_TOKEN, pollTime:30, lastEventId:vkCur } }),
      {label:'vkPoll', tries:Infinity, base:800}
    );

    if(!Array.isArray(data.events)) return;
    for(const ev of data.events){
      vkCur = ev.eventId;
      if(ev.type!=='newMessage') continue;
      const p = ev.payload; if(!p) continue;

      const vkId = p.chat.chatId;
      const u = usr(vkId);

      /* /reset */
      if((p.text||'').trim()==='/reset'){
        reset(vkId);
        vkSendText(vkId,'🗑️ Сброшено. Пришлите новый токен (TG-бота).');
        continue;
      }

      /* stage 1: await_token */
      if(u.stage==='await_token'){
        const t=(p.text||'').trim();
        if(/^\d{6,12}:[\w-]{30,}$/.test(t)){
          const h = addToken(t);
          u.tgHash = h;
          u.stage  = 'await_first_msg';
          save();
          vkSendText(vkId,'✅ Токен принят. Отправьте /start TG-боту (и/или добавьте в группу).');
          startTGloop(h);

          // если peers уже есть у другого VK-пользователя с тем же токеном — копируем
          const any = Object.values(db.users).find(x=>x!==u && x.tgHash===h && Object.keys(x.peers).length);
          if(any){
            for(const [cid,info] of Object.entries(any.peers))
              u.peers[cid] = {...info};
            u.nextIdx  = any.nextIdx;
            u.selected = Object.values(u.peers)[0]?.chatId || null;
            u.stage='ready'; save();
            vkSendText(vkId,'🔗 Связь установлена (повторно). /list чтобы посмотреть.');
          }
        } else {
          vkSendText(vkId,'Пришлите токен TG-бота (формат 123456789:AA…).');
        }
        continue;
      }

      /* stage 2: await_first_msg */
      if(u.stage==='await_first_msg'){
        vkSendText(vkId,'⏳ Жду первого сообщения от вашего TG-бота…');
        continue;
      }

      /* /list */
      if((p.text||'').startsWith('/list')){
        const list = Object.values(u.peers).map(o=>`[${o.idx}] ${o.name}`).join('\n') || '-нет-';
        vkSendText(vkId, 'Адресаты:\n'+list);
        continue;
      }

      /* /to ... */
      const mTo = (p.text||'').match(/^\/to\s+(.+)/i);
      if(mTo){
        const key = mTo[1].trim();
        const peer = Object.values(u.peers)
          .find(o=> String(o.idx)===key || o.name===key || ('@'+o.name)===key);
        if(peer){
          u.selected = peer.chatId; save();
          vkSendText(vkId, '▶ '+peer.name);
        } else {
          vkSendText(vkId, 'Не найден. /list');
        }
        continue;
      }

      /* no selected peer */
      if(!u.selected){
        const names = Object.values(u.peers).map(o=>`[${o.idx}] ${o.name}`).join('\n') || '-нет-';
        vkSendText(vkId, 'Кому отправить?\n'+names+'\nИспользуйте /to …');
        continue;
      }

      /* forward message VK → TG */
      await sendVKtoTG(p, u);
    }

  }catch(e){
    const st = e?.response?.status;
    if(st && st!==504) console.error('VK loop error:', redact(e.message));
  }finally{
    setImmediate(pollVK);
  }
}

/* VK → TG */
async function sendVKtoTG(p, u){
  const tok = getTok(u.tgHash);
  if(!tok){ await vkSendText(p.chat.chatId, '❌ TG-токен недоступен. /reset и начните заново.'); return; }
  const TG = `https://api.telegram.org/bot${tok}`;

  if(p.text){
    await withBackoff(
      ()=>axios.post(TG+'/sendMessage',
        new URLSearchParams({ chat_id:u.selected, text:p.text }),
        { headers:{'Content-Type':'application/x-www-form-urlencoded'} }),
      {label:'tgSendMessage'}
    );
  }

  if(!Array.isArray(p.parts)) return;
  for(const part of p.parts){
    const fileId = part.payload?.fileId;
    if(!fileId) continue;
    const {data:info} = await vkGetFileInfo(fileId);
    const {data:bin}  = await vkGetFileBin(fileId);
    const f = new FormData();
    f.append('chat_id', u.selected);
    f.append('document', Buffer.from(bin), { filename: ext(info.filename, info.type) });
    await withBackoff(()=>axios.post(TG+'/sendDocument', f, { headers:f.getHeaders() }), {label:'tgSendDocument'});
  }
}

/* ============================================================
   2) TG LOOPS (per-token by hash)
============================================================ */
function startTGloop(tgHash){
  if(tgLoops.has(tgHash)) return;
  const tok = getTok(tgHash);
  if(!tok){ console.warn('⚠️ startTGloop: token missing for', tgHash); return; }

  const TG = `https://api.telegram.org/bot${tok}`;
  // 1) гарантированно отключаем webhook
  withBackoff(
    ()=>axios.post(TG+'/deleteWebhook', new URLSearchParams({ drop_pending_updates:true })),
    {label:'tgDeleteWebhook'}
  ).catch(()=>{ /* ignore */ });

  db.tokens[tgHash].polling = true;
  db.tokens[tgHash].offset  = db.tokens[tgHash].offset || 0;
  save();

  const fn = ()=>pollTG(tgHash);
  tgLoops.set(tgHash, fn);
  fn();
}

async function pollTG(tgHash){
  const tok = getTok(tgHash);
  if(!tok){ console.warn('⚠️ pollTG: token missing for', tgHash); return; }
  const TG = `https://api.telegram.org/bot${tok}`;

  try{
    const {data} = await withBackoff(
      ()=>axios.get(TG+'/getUpdates', { params:{ offset:db.tokens[tgHash].offset, timeout:30 } }),
      {label:'tgGetUpdates', tries:Infinity, base:800}
    );

    for(const upd of (data.result||[])){
      db.tokens[tgHash].offset = upd.update_id + 1; save();
      const m = upd.message || upd.edited_message; // иногда удобно ловить и отредактированные
      if(!m || m.from?.is_bot) continue;

      // размечаем/создаём peer-ы у всех VK-пользователей, кто использует этот tgHash
      for(const [vkId, u] of Object.entries(db.users)){
        if(u.tgHash !== tgHash) continue;

        let peer = u.peers[m.chat.id];
        if(!peer){
          // имя: для групп берём title, для лички — @username/first_name
          const name =
            m.chat.type.endsWith('group') ? (m.chat.title || `Group_${m.chat.id}`) :
            (m.from?.username ? ('@'+m.from.username) : (m.from?.first_name || 'User'));

          peer = u.peers[m.chat.id] = { chatId:m.chat.id, name, idx:u.nextIdx++ };
          save();
        }
        const pre = `[${peer.idx}] ${peer.name}: `;

        if(u.stage === 'await_first_msg'){
          u.stage='ready'; u.selected = m.chat.id; save();
          vkSendText(vkId, '🔗 Связь установлена!\n/list — адресаты, /to — выбрать.');
        }

        // текст-нотификация
        if(m.text) await vkSendText(vkId, pre + m.text);
        else       await vkSendText(vkId, pre + '📎');

        // медиа → VK
        await tgMediaToVK(m, TG, vkId, pre);
      }
    }

  }catch(e){
    if(e?.response?.status === 409){
      // webhook снова включился? снимаем.
      await axios.post(TG+'/deleteWebhook',
        new URLSearchParams({ drop_pending_updates:true })).catch(()=>{});
    } else {
      console.error('TG loop error:', redact(e.message));
    }
  }finally{
    setImmediate(()=>pollTG(tgHash));
  }
}

/* TG media → VK */
async function tgMediaToVK(m,TG,vkId,pre){
  const key = ['photo','document','audio','voice','video','animation','sticker'].find(k=>m[k]);
  if(!key) return;

  let fileId, fn;
  if(key==='photo'){ fileId = m.photo.at(-1).file_id; fn = fileId+'.jpg'; }
  else if(key==='sticker'){ fileId = m.sticker.file_id; fn = (m.sticker.emoji || 'sticker') + '.webp'; }
  else if(key==='animation'){ fileId = m.animation.file_id; fn = m.animation.file_name || 'animation.mp4'; }
  else { fileId = m[key].file_id; fn = m[key].file_name || fileId; }

  const {data:{result:{file_path}}} = await withBackoff(
    ()=>axios.get(TG+'/getFile', { params:{ file_id:fileId } }),
    {label:'tgGetFile'}
  );

  const fileUrl = TG.replace('/bot'+getTok(sha256(getTok(sha256('dummy')))), ''); // not used, but prevents accidental token leak
  // корректный способ построить file URL:
  const base = 'https://api.telegram.org';
  const stream = await withBackoff(
    ()=>axios.get(`${base}/file/bot${getTok(sha256(getTok(sha256('dummy'))))}/${file_path}`, { responseType:'stream' }),
    {label:'tgDownloadFile'}
  ).catch(async()=>{
    // безопаснее явно формировать без странных замен:
    return await axios.get(`${base}/file/bot${getTokOfVKUser(vkId)}/${file_path}`, { responseType:'stream' });
  });

  await vkSendText(vkId, pre+'(файл)');
  await vkSendFile(vkId, stream.data, fn);
}

// вспомогательная: получаем актуальный токен для vkId (по его tgHash)
function getTokOfVKUser(vkId){
  const u = db.users[vkId];
  return u?.tgHash ? tokCache.get(u.tgHash) : null;
}

/* ============================================================
   START & SIGNALS
============================================================ */
console.log('🔄 Bridge запущен. Отправьте токен TG-бота в личку VK-бота.');
pollVK();

// поднимаем все сохранённые TG петли
Object.keys(db.tokens||{}).forEach(h=>{
  if(db.tokens[h].polling) startTGloop(h);
});

// аккуратное завершение
['SIGINT','SIGTERM'].forEach(sig=>{
  process.on(sig, ()=>{
    console.log(`\n🛑 ${sig} — сохраним состояние и завершимся…`);
    try{ save(); }catch{}
    process.exit(0);
  });
});
