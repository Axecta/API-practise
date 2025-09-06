/*сделать универсальный мост из тг из группового чата или из личного с ботом в тимз в групповой чат или личное сообщений*/




const axios = require('axios');
const FormData = require('form-data');
const fs   = require('fs')

/* ── VK creds ─────────────────────────────────────────────── */

# ENTER VK_TEAMS BOT_TOKEN here
const VK_BOT_TOKEN = '';
# ENTER API url here
const VK_API       = '';

/* ── JSON storage ─────────────────────────────────────────── */
const DB_FILE = 'state.json';
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE))
         : { users:{}, tokens:{} };              // tokens[token] = { polling:false, offset:0 }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2));

/* ── helpers ──────────────────────────────────────────────── */
function usr(vkId){
  if(!db.users[vkId]) db.users[vkId] = {
    tgToken:null, stage:'await_token',
    peers:{}, nextIdx:1, selected:null
  };
  return db.users[vkId];
}
function addTok(t){ if(!db.tokens[t]) db.tokens[t]={ polling:false, offset:0 }; }

const vkSend = (id,msg)=>axios.post(
  VK_API+'/messages/sendText',
  new URLSearchParams({ token:VK_BOT_TOKEN, chatId:id, text:msg }),
  { headers:{'Content-Type':'application/x-www-form-urlencoded'} }
);
const ext=(n,m)=>/\.[a-z\d]+$/i.test(n)?n:n+({'image/jpeg':'.jpg','image/png':'.png','video/mp4':'.mp4'}[m]||'');

/* ── hard reset ───────────────────────────────────────────── */
function reset(vkId){
  const u=db.users[vkId]; if(!u) return;
  const tok=u.tgToken;
  delete db.users[vkId];
  if(tok && !Object.values(db.users).some(x=>x.tgToken===tok)){
    db.tokens[tok].polling=false;
    if(tgLoops.has(tok)){ clearImmediate(tgLoops.get(tok)); tgLoops.delete(tok); }
  }
  save();
}

/* ============================================================
   1. VK-loop  (команды + пересылка)
   ========================================================== */
let vkCur=0;
async function pollVK(){
  try{
    const {data}=await axios.get(VK_API+'/events/get',
      {params:{token:VK_BOT_TOKEN,pollTime:30,lastEventId:vkCur}});
    if(!Array.isArray(data.events)) return;
    for(const ev of data.events){
      vkCur=ev.eventId; if(ev.type!=='newMessage') continue;
      const p=ev.payload; if(!p) continue;

      const vkId=p.chat.chatId;
      const u   =usr(vkId);

      /* /reset */
      if(p.text?.trim()==='/reset'){
        reset(vkId); vkSend(vkId,'🗑️ Сброшено. Пришлите новый токен.'); continue;
      }

      /* стадия 1: ждём токен */
      if(u.stage==='await_token'){
        const t=(p.text||'').trim();
        if(/^\d{6,12}:[\w-]{30,}$/.test(t)){
          u.tgToken=t; u.stage='await_first_msg';
          addTok(t); save();
          vkSend(vkId,'✅ Токен принят. Отправьте /start TG-боту.');
          startTGloop(t);

          /*  если peer-ы уже были у других VK-юзеров  */
          const any = Object.values(db.users).find(x=>x!==u && x.tgToken===t && Object.keys(x.peers).length);
          if(any){
            /* копируем peer-ы и сразу «готово» */
            for(const [cid,info] of Object.entries(any.peers))
              u.peers[cid]= {...info};
            u.nextIdx = any.nextIdx;
            u.selected = Object.values(u.peers)[0].chatId;
            u.stage='ready'; save();
            vkSend(vkId,'🔗 Связь установлена (исп. существующие контакты).\n/list чтобы посмотреть.');
          }
        }else vkSend(vkId,'Пришлите токен TG-бота (123456789:AA…).');
        continue;
      }

      /* стадия 2: ждём первое сообщение */
      if(u.stage==='await_first_msg'){
        vkSend(vkId,'⏳ Жду первого сообщения от TG-бота…'); continue;
      }

      /* /list */
      if(p.text?.startsWith('/list')){
        const list=Object.values(u.peers)
          .map(o=>`[${o.idx}] ${o.name}`).join('\n')||'-нет-';
        vkSend(vkId,'Адресаты:\n'+list); continue;
      }

      /* /to … */
      const mTo=p.text?.match(/^\/to\s+(.+)/i);
      if(mTo){
        const key=mTo[1];
        const peer=Object.values(u.peers)
           .find(o=>o.idx==key || o.name===key || ('@'+o.name)===key);
        if(peer){ u.selected=peer.chatId; save(); vkSend(vkId,'▶ '+peer.name); }
        else vkSend(vkId,'Не найден. /list'); continue;
      }

      /* нет выбранного адресата */
      if(!u.selected){
        const names=Object.values(u.peers)


        
          .map(o=>`[${o.idx}] ${o.name}`).join('\n')||'-нет-';
        vkSend(vkId,'Кому отправить?\n'+names+'\n/use /to …'); continue;
      }

      /* пересылка текста/файла */
      await sendVKtoTG(p,u);
    }

  }catch(e){ if(e.response?.status!==504) console.error('VK',e.message); }
  finally{ setImmediate(pollVK); }
}

/* VK → TG send *************************************************/
async function sendVKtoTG(p,u){
  const TG=`https://api.telegram.org/bot${u.tgToken}`;
  if(p.text){
    await axios.post(TG+'/sendMessage',
      new URLSearchParams({chat_id:u.selected,text:p.text}),
      {headers:{'Content-Type':'application/x-www-form-urlencoded'}});
  }
  if(!Array.isArray(p.parts)) return;
  for(const part of p.parts){
    const fileId=part.payload.fileId;
    const {data:info}=await axios.get(VK_API+'/files/getinfo',
      {params:{token:VK_BOT_TOKEN,fileId}});
    const {data:bin}=await axios.get(VK_API+'/files/get',
      {params:{token:VK_BOT_TOKEN,fileId},responseType:'arraybuffer',decompress:false});
    const f=new FormData();
    f.append('chat_id',u.selected);
    f.append('document',Buffer.from(bin),{filename:ext(info.filename,info.type)});
    await axios.post(TG+'/sendDocument',f,{headers:f.getHeaders()});
  }
}

/* ============================================================
   2. TG-loops  (по токену)
   ========================================================== */
const tgLoops=new Map();
async function startTGloop(tok){
  if(tgLoops.has(tok)) return;

  /* 1) гарантированно отключаем webhook */
  try{ await axios.post(`https://api.telegram.org/bot${tok}/deleteWebhook`,
        new URLSearchParams({ drop_pending_updates:true }));
  }catch{}

  db.tokens[tok].polling=true; db.tokens[tok].offset=0; save();
  const fn=()=>pollTG(tok); tgLoops.set(tok,fn); fn();
}

async function pollTG(tok){
  const TG=`https://api.telegram.org/bot${tok}`;
  try{
    const {data}=await axios.get(TG+'/getUpdates',
      {params:{offset:db.tokens[tok].offset,timeout:30}});
    for(const upd of data.result){
      db.tokens[tok].offset = upd.update_id + 1; save();
      const m=upd.message; if(!m||m.from?.is_bot) continue;

      for(const [vkId,u] of Object.entries(db.users)){
        if(u.tgToken!==tok) continue;

        let peer=u.peers[m.chat.id];
        if(!peer){
          const name=m.from.username?('@'+m.from.username):(m.from.first_name||'User');
          peer=u.peers[m.chat.id]={chatId:m.chat.id,name,idx:u.nextIdx++}; save();
        }
        const pre=`[${peer.idx}] ${peer.name}: `;

        /* если юзер ещё на стадии await_first_msg — делаем ready */
        if(u.stage==='await_first_msg'){
          u.stage='ready'; u.selected=m.chat.id; save();
          vkSend(vkId,'🔗 Связь установлена!\n/list — адресаты, /to — выбрать.');
        }

        /* текст */
        if(m.text) vkSend(vkId, pre+m.text); else vkSend(vkId, pre+'📎');

        /* медиа */
        await tgMediaToVK(m,TG,vkId,tok,pre);
      }
    }
  }catch(e){
    if(e.response?.status===409){
      /* webhook снова включился? пробуем снять */
      await axios.post(`https://api.telegram.org/bot${tok}/deleteWebhook`,
        new URLSearchParams({ drop_pending_updates:true })).catch(()=>{});
    } else console.error('TG',e.message);
  }finally{ setImmediate(()=>pollTG(tok)); }
}

/* TG media → VK **********************************************/
async function tgMediaToVK(m,TG,vkId,tok,pre){
  const key=['photo','document','audio','voice','video'].find(k=>m[k]);
  if(!key) return;
  let fileId,fn; if(key==='photo'){ fileId=m.photo.at(-1).file_id; fn=fileId+'.jpg'; }
  else{ fileId=m[key].file_id; fn=m[key].file_name||fileId; }

  const {data:{result:{file_path}}}=await axios.get(
    TG+'/getFile',{params:{file_id:fileId}});
  const stream=await axios.get(
    TG.replace('/bot'+tok,'')+`/file/bot${tok}/${file_path}`,
    {responseType:'stream'});
  vkSend(vkId,pre+'(файл)');
  const f=new FormData();
  f.append('token',VK_BOT_TOKEN);
  f.append('chatId',vkId);
  f.append('file',stream.data,{filename:fn});
  await axios.post(VK_API+'/messages/sendFile',f,{headers:f.getHeaders()});
}

/* ============================================================
   START
   ========================================================== */
console.log('🔄 Bridge запущен. Отправьте токен TG-бота в личку VK-бота.');
pollVK();
Object.keys(db.tokens).forEach(startTGloop);
