const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'doce-encontro.sqlite'));
db.exec(`
 PRAGMA journal_mode = WAL;
 CREATE TABLE IF NOT EXISTS products (
   id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
   price REAL NOT NULL CHECK(price >= 0), tag TEXT NOT NULL DEFAULT '', description TEXT NOT NULL,
   image_url TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS orders (
   id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL UNIQUE,
   customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
   note TEXT NOT NULL DEFAULT '', total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Recebido',
   payment_token TEXT,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS order_items (
   id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
   product_name TEXT NOT NULL, unit_price REAL NOT NULL, quantity INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS reservations (
   id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL, people TEXT NOT NULL,
   date TEXT NOT NULL, time TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
   status TEXT NOT NULL DEFAULT 'Solicitada', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
`);
if (!db.prepare('PRAGMA table_info(orders)').all().some(column => column.name === 'payment_token')) {
 db.exec('ALTER TABLE orders ADD COLUMN payment_token TEXT');
}
const initialProducts = [
 ['Brownie Creeper','brownie',18,'Bloco de chocolate','Brownie de chocolate intenso com cobertura verde quadriculada inspirada no Creeper.','assets/brownie-creeper.jfif'],
 ['Cupcakes Minions','cupcake',15,'Amarelinhos','Cupcakes de chocolate com cobertura amarela e decoração divertida dos Minions.','assets/cupcakes-minions.jfif'],
 ['Doce Bloco Surpresa','bolo',22,'Surpresa doce','Bolo em formato de bloco com recheio cremoso, inspirado nos itens surpresa dos jogos.','assets/doce-bloco-surpresa.jfif'],
 ['Coquetel Maléfica','bebida',28,'Alcoólico • 18+','Coquetel escuro de vodka preta, licor de cereja e suco de amora. Contém álcool; venda proibida para menores de 18 anos.','assets/coquetel-malefica.jpeg'],
 ['Coquetel Rainha Má','bebida',28,'Alcoólico • 18+','Mistura rosa de vodka sabor chiclete, vodka de maçã, cherryade e refrigerante cremoso. Contém álcool; venda proibida para menores de 18 anos.','assets/coquetel-rainha-ma.jpeg'],
 ['Coquetel Dr. Facilier','bebida',28,'Alcoólico • 18+','Coquetel de vodka de framboesa, tequila, curaçau blue, grenadine e suco de mirtilo. Contém álcool; venda proibida para menores de 18 anos.','assets/coquetel-dr-facilier.jpeg'],
 ['Combo Barbie Land','combo',39.9,'Combo temático','Hambúrguer temático com molho rosado, batata frita e milkshake rosa, inspirado no Barbie Land.','assets/combo-barbie-land.jfif'],
 ['Milkshake da Barbie','bebida',22,'Rosa e cremoso','Milkshake rosa de morango, finalizado com chantilly, confeitos de coração e morango.','assets/milkshake-barbie.jfif']
];
const insertSeed = db.prepare('INSERT INTO products(name,category,price,tag,description,image_url) VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO NOTHING');
for (const p of initialProducts) insertSeed.run(...p);
const sessions = new Map();
const loginAttempts = new Map();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PIX_KEY = process.env.PIX_KEY || '';
const PIX_RECEIVER_NAME = (process.env.PIX_RECEIVER_NAME || 'C YASMIN').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().slice(0,25);
const PIX_CITY = (process.env.PIX_CITY || 'PETROLINA').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().slice(0,15);
const PORT = Number(process.env.PORT || 4173);
const statuses = new Set(['Recebido','Aceito','Pago','Em preparo','Saiu para entrega','Concluído','Cancelado']);
function json(res, status, data) {
 const body = JSON.stringify(data);
 res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});
 res.end(body);
}
function readBody(req) {
 return new Promise((resolve,reject)=>{
  let raw='';
  req.on('data',chunk=>{raw+=chunk;if(raw.length>300_000){reject(new Error('Corpo muito grande'));req.destroy();}});
  req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch{reject(new Error('JSON inválido'));}});
  req.on('error',reject);
 });
}
function clean(value,max=400) { return String(value ?? '').trim().slice(0,max); }
function pixField(id,value) { const length=Buffer.byteLength(value,'utf8');return id+String(length).padStart(2,'0')+value; }
function pixCrc16(value) { let crc=0xFFFF;for(let i=0;i<value.length;i++){crc^=value.charCodeAt(i)<<8;for(let bit=0;bit<8;bit++)crc=(crc&0x8000)?((crc<<1)^0x1021)&0xFFFF:(crc<<1)&0xFFFF;}return crc.toString(16).toUpperCase().padStart(4,'0'); }
function makePixPayload(amount,reference) {
 const account=pixField('00','br.gov.bcb.pix')+pixField('01',PIX_KEY);
 const additional=pixField('05',reference.replace(/[^A-Z0-9]/gi,'').slice(0,25));
 const body=pixField('00','01')+pixField('01','11')+pixField('26',account)+pixField('52','0000')+pixField('53','986')+pixField('54',Number(amount).toFixed(2))+pixField('58','BR')+pixField('59',PIX_RECEIVER_NAME)+pixField('60',PIX_CITY)+pixField('62',additional)+'6304';
 return body+pixCrc16(body);
}
function requireAdmin(req,res) {
 const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 const exp=sessions.get(token);
 if(!exp || exp<Date.now()){sessions.delete(token);json(res,401,{error:'Sua sessão expirou. Entre novamente.'});return false;}
 sessions.set(token,Date.now()+8*60*60*1000); return true;
}
function validImage(url) { return /^https:\/\//i.test(url) || /^http:\/\//i.test(url) || /^assets\/[a-z0-9._/-]+$/i.test(url); }
const publicProduct = r => ({id:r.id,name:r.name,category:r.category,price:r.price,tag:r.tag,description:r.description,image_url:r.image_url});
async function api(req,res,url) {
 if(req.method==='GET' && url.pathname==='/api/products'){
  return json(res,200,db.prepare('SELECT id,name,category,price,tag,description,image_url FROM products WHERE active=1 ORDER BY id').all().map(publicProduct));
 }
 if(req.method==='POST' && url.pathname==='/api/admin/login'){
  if(!ADMIN_PASSWORD)return json(res,503,{error:'O painel ainda não tem uma senha configurada.'});
  const ip=req.socket.remoteAddress||'unknown';const a=loginAttempts.get(ip)||{n:0,until:0};
  if(a.until>Date.now()) return json(res,429,{error:'Muitas tentativas. Aguarde 15 minutos.'});
  let b;try{b=await readBody(req);}catch{return json(res,400,{error:'Dados inválidos.'});}
  const sent=crypto.createHash('sha256').update(String(b.password||'')).digest();const expected=crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if(!crypto.timingSafeEqual(sent,expected)){a.n++;if(a.n>=5){a.n=0;a.until=Date.now()+15*60*1000;}loginAttempts.set(ip,a);return json(res,401,{error:'Senha incorreta.'});}
  loginAttempts.delete(ip);const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+8*60*60*1000);return json(res,200,{token});
 }
 if(req.method==='POST' && url.pathname==='/api/orders'){
  let b;try{b=await readBody(req);}catch{return json(res,400,{error:'Confira os dados do pedido.'});}
  const customer=clean(b.customer_name,100), phone=clean(b.phone,30), address=clean(b.address,300), note=clean(b.note,500);
  if(!customer||!phone||!address||!Array.isArray(b.items)||!b.items.length||b.items.length>30)return json(res,400,{error:'Informe nome, telefone, endereço e os produtos do pedido.'});
  const orderItems=[];let total=0;
  for(const line of b.items){const id=Number(line.product_id),qty=Number(line.quantity);if(!Number.isInteger(id)||!Number.isInteger(qty)||qty<1||qty>50)return json(res,400,{error:'Produto ou quantidade inválida.'});const p=db.prepare('SELECT name,price FROM products WHERE id=? AND active=1').get(id);if(!p)return json(res,400,{error:'Um dos produtos não está mais disponível.'});orderItems.push({name:p.name,price:p.price,quantity:qty});total+=p.price*qty;}
  const orderNumber='DE-'+Date.now().toString().slice(-8),paymentToken=crypto.randomBytes(24).toString('hex');
  const save=db.prepare('INSERT INTO orders(order_number,customer_name,phone,address,note,total,payment_token) VALUES(?,?,?,?,?,?,?)');
  const result=save.run(orderNumber,customer,phone,address,note,total,paymentToken);
  const itemSave=db.prepare('INSERT INTO order_items(order_id,product_name,unit_price,quantity) VALUES(?,?,?,?)');
  for(const item of orderItems)itemSave.run(Number(result.lastInsertRowid),item.name,item.price,item.quantity);
  return json(res,201,{order_number:orderNumber,total,tracking_token:paymentToken});
 }
 const publicOrder=url.pathname.match(/^\/api\/orders\/(DE-\d+)$/);
 if(req.method==='GET'&&publicOrder){
  const record=db.prepare('SELECT order_number,total,status,created_at,payment_token FROM orders WHERE order_number=?').get(publicOrder[1]);
  const supplied=String(url.searchParams.get('token')||'');
  if(!record||!supplied||!crypto.timingSafeEqual(crypto.createHash('sha256').update(supplied).digest(),crypto.createHash('sha256').update(record.payment_token||'').digest()))return json(res,404,{error:'Pedido não encontrado.'});
  const result={order_number:record.order_number,total:record.total,status:record.status,created_at:record.created_at};
  if(record.status==='Aceito'){
   result.payment=PIX_KEY?{configured:true,pix_payload:makePixPayload(record.total,record.order_number)}:{configured:false};
  }
  return json(res,200,result);
 }
 if(req.method==='POST' && url.pathname==='/api/reservations'){
  let b;try{b=await readBody(req);}catch{return json(res,400,{error:'Dados da reserva inválidos.'});}
  const name=clean(b.name,100),people=clean(b.people,40),date=clean(b.date,10),time=clean(b.time,5),note=clean(b.note,500);
  if(!name||!people||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))return json(res,400,{error:'Preencha os dados da reserva.'});
  const result=db.prepare('INSERT INTO reservations(customer_name,people,date,time,note) VALUES(?,?,?,?,?)').run(name,people,date,time,note);
  return json(res,201,{id:Number(result.lastInsertRowid)});
 }
 if(url.pathname.startsWith('/api/admin/')){
  if(!requireAdmin(req,res))return;
  if(req.method==='GET'&&url.pathname==='/api/admin/orders'){
   const orders=db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all();
   const getItems=db.prepare('SELECT product_name,unit_price,quantity FROM order_items WHERE order_id=?');
   return json(res,200,orders.map(o=>({...o,items:getItems.all(o.id)})));
  }
  if(req.method==='GET'&&url.pathname==='/api/admin/reservations')return json(res,200,db.prepare('SELECT * FROM reservations ORDER BY id DESC LIMIT 300').all());
  if(req.method==='GET'&&url.pathname==='/api/admin/products')return json(res,200,db.prepare('SELECT * FROM products ORDER BY id DESC').all());
  const orderMatch=url.pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
 if(req.method==='PATCH'&&orderMatch){let b;try{b=await readBody(req);}catch{return json(res,400,{error:'Dados inválidos.'});}if(!statuses.has(b.status))return json(res,400,{error:'Status inválido.'});db.prepare('UPDATE orders SET status=? WHERE id=?').run(b.status,Number(orderMatch[1]));return json(res,200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/admin/products'){
   let b;try{b=await readBody(req);}catch{return json(res,400,{error:'Dados inválidos.'});}
   const name=clean(b.name,100),category=clean(b.category,30),tag=clean(b.tag,60),description=clean(b.description,500),image=clean(b.image_url,500),price=Number(b.price);
   if(!name||!category||!description||!Number.isFinite(price)||price<0||!validImage(image))return json(res,400,{error:'Confira nome, categoria, descrição, preço e imagem (URL http(s) ou caminho assets/).'});
   try{const result=db.prepare('INSERT INTO products(name,category,price,tag,description,image_url) VALUES(?,?,?,?,?,?)').run(name,category,price,tag,description,image);return json(res,201,{id:Number(result.lastInsertRowid)});}catch{return json(res,409,{error:'Já existe um produto com esse nome.'});}
  }
  const productMatch=url.pathname.match(/^\/api\/admin\/products\/(\d+)$/);
  if(req.method==='DELETE'&&productMatch){db.prepare('UPDATE products SET active=0 WHERE id=?').run(Number(productMatch[1]));return json(res,200,{ok:true});}
  return json(res,404,{error:'Rota administrativa não encontrada.'});
 }
 return json(res,404,{error:'Rota não encontrada.'});
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.jfif':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function staticFile(req,res,url){
 let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return json(res,400,{error:'Caminho inválido.'});}
 if(pathname==='/')pathname='/index.html';
 if(pathname==='/admin')pathname='/index.html';
 if(/^\/pedido\/DE-\d+$/.test(pathname))pathname='/order.html';
 if(pathname!=='/index.html'&&pathname!=='/order.html'&&!pathname.startsWith('/assets/'))return json(res,404,{error:'Arquivo não encontrado.'});
 const file=path.resolve(ROOT,'.'+pathname);
 if(file!==ROOT&&!file.startsWith(ROOT+path.sep))return json(res,403,{error:'Acesso negado.'});
 fs.stat(file,(err,stat)=>{if(err||!stat.isFile())return json(res,404,{error:'Arquivo não encontrado.'});res.writeHead(200,{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':stat.size,'X-Content-Type-Options':'nosniff'});fs.createReadStream(file).pipe(res);});
}
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/')){api(req,res,url).catch(e=>{console.error(e);if(!res.headersSent)json(res,500,{error:'Erro interno do servidor.'});});}else if(req.method==='GET'||req.method==='HEAD')staticFile(req,res,url);else json(res,405,{error:'Método não permitido.'});});
server.listen(PORT,'0.0.0.0',()=>console.log(`Doce Encontro disponível na porta ${PORT}`));



