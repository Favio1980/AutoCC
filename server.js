require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json({ limit: '50mb' }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ─── MONGODB ─────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ MongoDB conectado')).catch(err => console.error('❌ MongoDB error:', err));

const jugadorSchema = new mongoose.Schema({
  telegramId:    { type: String, unique: true },
  nombre:        String,
  usuarioCasino: String,
  estado:        { type: String, default: 'nuevo' },
  historial:     [{ rol: String, contenido: String }],
  creadoEn:      { type: Date, default: Date.now },
});
const Jugador = mongoose.model('Jugador', jugadorSchema);

const transaccionSchema = new mongoose.Schema({
  telegramId: String,
  monto:      Number,
  estado:     { type: String, default: 'pendiente' },
  textoOCR:   String,
  creadoEn:   { type: Date, default: Date.now },
});
const Transaccion = mongoose.model('Transaccion', transaccionSchema);

const contadorSchema = new mongoose.Schema({ nombre: { type: String, unique: true }, valor: { type: Number, default: 0 } });
const Contador = mongoose.model('Contador', contadorSchema);

async function obtenerSiguienteNumero() {
  const c = await Contador.findOneAndUpdate({ nombre: 'jugadores' }, { $inc: { valor: 1 } }, { new: true, upsert: true });
  return c.valor;
}

// ─── OCR ─────────────────────────────────────────────────────────────────────
let visionClient;
try {
  const credentials = JSON.parse(process.env.OCR_CREDENTIALS_JSON);
  visionClient = new vision.ImageAnnotatorClient({ credentials });
  console.log('✅ OCR inicializado');
} catch (err) { console.error('❌ OCR error:', err.message); }

async function extraerMonto(base64Image) {
  try {
    const [result] = await visionClient.textDetection({ image: { content: base64Image } });
    const texto = result.textAnnotations.length ? result.textAnnotations[0].description : '';
    const patrones = [/\$\s*([\d.,]+)/g, /(?:monto|importe|total|transferencia|enviaste|recibiste)[:\s]*\$?\s*([\d.,]+)/gi, /(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?)/g];
    const montos = [];
    for (const p of patrones) { let m; while ((m = p.exec(texto)) !== null) { const n = parseFloat(m[1].replace(/\./g, '').replace(',', '.')); if (n > 100 && n < 10000000) montos.push(n); } }
    const alias = (process.env.CBU_ALIAS || '').toLowerCase();
    return { texto, montoDetectado: montos.length > 0 ? Math.max(...montos) : null, cbuVerificado: alias ? texto.toLowerCase().includes(alias) : false };
  } catch (err) { return { texto: '', montoDetectado: null, cbuVerificado: false }; }
}

// ─── ANTHROPIC ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function responderConIA(jugador, mensaje) {
  const system = `Sos un operador humano de casino online argentino. Te llamás Gustavo. Español rioplatense informal.
Casino: asesdelnorte.com y losasesdelnorte.com
Alias transferencias: ${process.env.CBU_ALIAS}
Monto mínimo: $${process.env.MONTO_MINIMO || 3000}
Jugador: ${jugador.nombre || 'desconocido'}, usuario: ${jugador.usuarioCasino || 'sin cuenta'}, estado: ${jugador.estado}
Frases cortas. Máximo 2-3 oraciones. 0-1 emojis. Palabras como dale, joya, che, buenas.`;

  const msgs = [...jugador.historial.map(h => ({ role: h.rol === 'user' ? 'user' : 'assistant', content: h.contenido })), { role: 'user', content: mensaje }];
  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 300, system, messages: msgs });
  return r.content[0].text;
}

// ─── TELEGRAM API ─────────────────────────────────────────────────────────────
async function enviarMensaje(chatId, texto) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: texto, parse_mode: 'Markdown' });
  } catch (err) { console.error('❌ Error enviando mensaje Telegram:', err.message); }
}

async function enviarAccionEscribiendo(chatId) {
  try { await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' }); } catch(e) {}
}

// ─── PLAYWRIGHT: CREAR USUARIO ───────────────────────────────────────────────
async function crearUsuario(nombre, numero) {
  const usuario = `Zzz${nombre}${numero}`;
  const contrasenia = '123';
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], headless: true });
    const page = await browser.newPage();
    await page.goto('https://asesdelnorte.com/NewAdmin/', { waitUntil: 'networkidle' });
    await page.fill('input[name="idusuario"]', process.env.CASINO_ADMIN_USER);
    await page.fill('input[name="contrasenia"]', process.env.CASINO_ADMIN_PASS);
    await page.click('input[type="image"]');
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { try { const c = await page.$('a:has-text("CONTINUAR"), a:has-text("HOME")'); if (c) { await c.click(); await page.waitForTimeout(1000); } } catch(e) {} }
    await page.goto('https://asesdelnorte.com/NewAdmin/RegistroJugador.php', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.fill('input[name="nombre"]', nombre);
    await page.fill('input[name="apellido"]', 'N');
    await page.fill('input[name="idusuario"]', usuario);
    await page.fill('input[name="contrasenia"]', contrasenia);
    await page.fill('input[name="contrasenia2"]', contrasenia);
    await page.fill('input[name="email"]', `${usuario.toLowerCase()}@gmail.com`);
    await page.click('input[type="image"]');
    await page.waitForTimeout(3000);
    const contenido = await page.content();
    return { exito: contenido.toLowerCase().includes('creado') || contenido.toLowerCase().includes('xito'), usuario, contrasenia };
  } catch (err) { return { exito: false, error: err.message }; }
  finally { if (browser) await browser.close(); }
}

// ─── PLAYWRIGHT: ACREDITAR FICHAS ────────────────────────────────────────────
async function acreditarFichas(usuarioCasino, monto) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], headless: true });
    const page = await browser.newPage();
    await page.goto('https://asesdelnorte.com/NewAdmin/', { waitUntil: 'networkidle' });
    await page.fill('input[name="idusuario"]', process.env.CASINO_ADMIN_USER);
    await page.fill('input[name="contrasenia"]', process.env.CASINO_ADMIN_PASS);
    await page.click('input[type="image"]');
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { try { const c = await page.$('a:has-text("CONTINUAR"), a:has-text("HOME")'); if (c) { await c.click(); await page.waitForTimeout(1000); } } catch(e) {} }
    await page.goto(`https://asesdelnorte.com/NewAdmin/Jugadores.php?usr=${usuarioCasino}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const frame = page.frames().find(f => f.url().includes('Jugadores'));
    if (frame) { await frame.click('text=Cargar'); } else { await page.click('text=Cargar'); }
    await page.waitForTimeout(2000);
    const cf = page.frames().find(f => f.url().includes('carga'));
    if (cf) { await cf.fill('input[name="importe"]', String(monto)); await cf.click('input[type="image"]'); }
    await page.waitForTimeout(2000);
    return { exito: true };
  } catch (err) { return { exito: false, error: err.message }; }
  finally { if (browser) await browser.close(); }
}

// ─── PROCESAR MENSAJE TELEGRAM ────────────────────────────────────────────────
async function procesarMensaje(chatId, telegramId, texto, foto) {
  try {
    let jugador = await Jugador.findOne({ telegramId });
    if (!jugador) jugador = await Jugador.create({ telegramId, estado: 'nuevo', historial: [] });

    await enviarAccionEscribiendo(chatId);

    // Comprobante de pago (foto)
    if (foto && jugador.estado === 'esperando_comprobante') {
      await enviarMensaje(chatId, '👀 vi el comprobante, lo estoy revisando...');
      try {
        // Obtener URL de la foto
        const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${foto}`);
        const filePath = fileInfo.data.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
        const imgResp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const base64 = Buffer.from(imgResp.data).toString('base64');
        
        const { montoDetectado, cbuVerificado } = await extraerMonto(base64);
        
        if (!montoDetectado) {
          await enviarMensaje(chatId, 'mmm no pude leer bien el comprobante, lo podés mandar de nuevo?');
        } else if (!cbuVerificado) {
          await enviarMensaje(chatId, `no veo transferencia al alias *${process.env.CBU_ALIAS}*, revisá que hayas mandado al alias correcto`);
        } else {
          await enviarMensaje(chatId, `joya! comprobante por *$${Number(montoDetectado).toLocaleString('es-AR')}* recibido ✅ acreditando las fichas...`);
          const result = await acreditarFichas(jugador.usuarioCasino, montoDetectado);
          await Transaccion.create({ telegramId, monto: montoDetectado, estado: result.exito ? 'acreditado' : 'revision_manual' });
          jugador.estado = 'activo';
          await jugador.save();
          const respuesta = result.exito 
            ? `listo! te acredité *$${Number(montoDetectado).toLocaleString('es-AR')}* en tu cuenta 🎰 ya podés jugar!`
            : `recibí el comprobante ✅ en unos minutos te confirmamos la acreditación`;
          await enviarMensaje(chatId, respuesta);
        }
      } catch(e) {
        console.error('Error procesando imagen:', e);
        await enviarMensaje(chatId, 'no pude procesar la imagen, la podés mandar de nuevo?');
      }
      return;
    }

    if (!texto) return;

    let respuesta = '';

    if (jugador.estado === 'nuevo') {
      jugador.estado = 'esperando_nombre';
      await jugador.save();
      respuesta = 'hola! bienvenido 🎰 para crear tu cuenta necesito tu nombre, cómo te llamás?';

    } else if (jugador.estado === 'esperando_nombre') {
      const nombre = texto.replace(/[^a-záéíóúñA-ZÁÉÍÓÚÑ\s]/g, '').trim();
      if (nombre.length < 2) {
        respuesta = 'no entendí bien, me repetís tu nombre?';
      } else {
        jugador.nombre = nombre;
        jugador.estado = 'creando_cuenta';
        await jugador.save();
        await enviarMensaje(chatId, `perfecto ${nombre}! creando tu cuenta, dame un segundo... 🎰`);
        const num = await obtenerSiguienteNumero();
        const result = await crearUsuario(nombre, num);
        if (result.exito) {
          jugador.usuarioCasino = result.usuario;
          jugador.estado = 'activo';
          await jugador.save();
          respuesta = `listo! tu cuenta está creada 🎉\n\n👤 Usuario: *${result.usuario}*\n🔑 Contraseña: *${result.contrasenia}*\n\n🌐 asesdelnorte.com\n\nPara cargar fichas transferís al alias *${process.env.CBU_ALIAS}* mínimo $${process.env.MONTO_MINIMO || 3000} y me mandás el comprobante acá 📸`;
        } else {
          jugador.estado = 'activo';
          await jugador.save();
          respuesta = `listo ${nombre}! en un momento te mandamos tus datos de acceso 🎰`;
        }
      }

    } else if (texto.match(/deposit|cargar|fichas|pagar|transferi|quiero cargar|cómo cargo|como cargo|saldo/i)) {
      jugador.estado = 'esperando_comprobante';
      await jugador.save();
      respuesta = `dale! transferís al alias:\n\n*${process.env.CBU_ALIAS}*\n\nmínimo $${process.env.MONTO_MINIMO || 3000} - cuando hagas la transf mandame el comprobante acá 📸`;

    } else if (jugador.estado === 'activo' && texto.match(/hola|buenas|buenos|hi|hey/i) && jugador.usuarioCasino) {
      respuesta = `hola ${jugador.nombre || ''}! 👋 ya tenés tu cuenta *${jugador.usuarioCasino}*. ¿Querés cargar fichas?`;

    } else {
      jugador.historial.push({ rol: 'user', contenido: texto });
      if (jugador.historial.length > 20) jugador.historial.shift();
      respuesta = await responderConIA(jugador, texto);
      jugador.historial.push({ rol: 'assistant', contenido: respuesta });
      await jugador.save();
    }

    if (respuesta) await enviarMensaje(chatId, respuesta);

  } catch (err) {
    console.error('❌ Error procesando mensaje:', err);
    await enviarMensaje(chatId, 'perdón, tuve un problema técnico. lo intentás de nuevo?');
  }
}

// ─── WEBHOOK TELEGRAM ─────────────────────────────────────────────────────────
app.post('/telegram', async (req, res) => {
  res.json({ ok: true });
  const update = req.body;
  console.log('📩 Telegram update:', JSON.stringify(update).substring(0, 200));

  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const texto = message.text || '';
  
  // Detectar foto
  let fotoFileId = null;
  if (message.photo && message.photo.length > 0) {
    fotoFileId = message.photo[message.photo.length - 1].file_id;
  }

  await procesarMensaje(chatId, telegramId, texto, fotoFileId);
});

// ─── MCP ─────────────────────────────────────────────────────────────────────
app.get('/mcp', (req, res) => {
  res.json({ name: 'Nebula Casino Tools', version: '1.0.0', tools: [
    { name: 'crear_usuario', description: 'Crea un usuario en el casino', inputSchema: { type: 'object', properties: { nombre: { type: 'string' }, telefono: { type: 'string' } }, required: ['nombre'] } },
    { name: 'acreditar_fichas', description: 'Acredita fichas', inputSchema: { type: 'object', properties: { usuario_casino: { type: 'string' }, monto: { type: 'number' } }, required: ['usuario_casino', 'monto'] } },
    { name: 'buscar_jugador', description: 'Busca jugador', inputSchema: { type: 'object', properties: { telegramId: { type: 'string' } }, required: ['telegramId'] } }
  ]});
});

// ─── PANEL ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🎰 Nebula Casino Backend funcionando'));
app.get('/panel', (req, res) => { const path = require('path'); res.sendFile(path.join(__dirname, 'panel.html')); });
app.get('/jugadores', async (req, res) => res.json(await Jugador.find({}).sort({ creadoEn: -1 })));
app.get('/transacciones', async (req, res) => res.json(await Transaccion.find().sort({ creadoEn: -1 }).limit(100)));

app.listen(port, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${port}`);
  // Configurar webhook de Telegram
  try {
    const webhookUrl = `https://gustavoases.com/telegram`;
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: webhookUrl });
    console.log(`✅ Webhook Telegram configurado: ${webhookUrl}`);
  } catch (err) {
    console.error('❌ Error configurando webhook Telegram:', err.message);
  }
});
