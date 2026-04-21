require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json({ limit: '50mb' }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ─── MONGODB ─────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB error:', err));

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
  imagenUrl:  String,
  creadoEn:   { type: Date, default: Date.now },
});
const Transaccion = mongoose.model('Transaccion', transaccionSchema);

const contadorSchema = new mongoose.Schema({
  nombre: { type: String, unique: true },
  valor:  { type: Number, default: 0 },
});
const Contador = mongoose.model('Contador', contadorSchema);

async function obtenerSiguienteNumero() {
  const c = await Contador.findOneAndUpdate(
    { nombre: 'jugadores' },
    { $inc: { valor: 1 } },
    { new: true, upsert: true }
  );
  return c.valor;
}

// ─── ANTHROPIC ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function responderConIA(jugador, mensaje) {
  const system = `Sos Gustavo, operador de casino online argentino. Español rioplatense informal.
Casino: asesdelnorte.com y losasesdelnorte.com
Alias para transferencias: ${process.env.CBU_ALIAS}
Monto mínimo carga: $${process.env.MONTO_MINIMO || 3000}
Monto mínimo retiro: $5000
Jugador: ${jugador.nombre || 'desconocido'}, usuario: ${jugador.usuarioCasino || 'sin cuenta'}
Frases cortas. Máximo 2 oraciones. 0-1 emojis. Palabras: dale, joya, che, buenas.
NO inventes datos. NO pidas mail ni teléfono.`;

  const msgs = [
    ...jugador.historial.map(h => ({ role: h.rol === 'user' ? 'user' : 'assistant', content: h.contenido })),
    { role: 'user', content: mensaje }
  ];

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    system,
    messages: msgs
  });
  return r.content[0].text;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function enviarMensaje(chatId, texto) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: texto,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error('❌ Error enviando mensaje:', err.message);
  }
}

async function enviarTyping(chatId) {
  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
  } catch(e) {}
}

// ─── PLAYWRIGHT: CREAR USUARIO ───────────────────────────────────────────────
async function crearUsuario(nombre, numero) {
  const usuario = `Zzz${nombre}${numero}`;
  const contrasenia = '123';
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    });
    const page = await browser.newPage();
    await page.goto('https://asesdelnorte.com/NewAdmin/login.php', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="nombreusuario"]', process.env.CASINO_ADMIN_USER);
    await page.fill('input[name="contrasenia"]', process.env.CASINO_ADMIN_PASS);
    await page.evaluate(() => document.querySelector('form').submit());
    await page.waitForTimeout(2000);
    try { await page.click('text=CONTINUAR', { timeout: 3000 }); await page.waitForTimeout(1500); } catch(e) {}
    try { await page.click('text=CONTINUAR', { timeout: 3000 }); await page.waitForTimeout(1500); } catch(e) {}
    await page.goto('https://asesdelnorte.com/NewAdmin/RegistroJugador.php', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.fill('input[name="nombre"]', nombre);
    await page.fill('input[name="apellido"]', 'N');
    await page.fill('input[name="idusuario"]', usuario);
    await page.fill('input[name="contrasenia"]', contrasenia);
    await page.fill('input[name="contrasenia2"]', contrasenia);
    await page.fill('input[name="email"]', `${usuario.toLowerCase()}@gmail.com`);
    await page.evaluate(() => document.querySelector('form').submit());
    await page.waitForTimeout(3000);
    const url = page.url();
    const exito = url.includes('creado') || url.includes('xito') || url.includes('Jugadores.php');
    return { exito, usuario, contrasenia };
  } catch (err) {
    console.error('❌ Error creando usuario:', err.message);
    return { exito: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── PLAYWRIGHT: ACREDITAR FICHAS ────────────────────────────────────────────
async function acreditarFichas(usuarioCasino, monto) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    });
    const page = await browser.newPage();
    await page.goto('https://asesdelnorte.com/NewAdmin/login.php', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="nombreusuario"]', process.env.CASINO_ADMIN_USER);
    await page.fill('input[name="contrasenia"]', process.env.CASINO_ADMIN_PASS);
    await page.evaluate(() => document.querySelector('form').submit());
    await page.waitForTimeout(2000);
    try { await page.click('text=CONTINUAR', { timeout: 3000 }); await page.waitForTimeout(1500); } catch(e) {}
    try { await page.click('text=CONTINUAR', { timeout: 3000 }); await page.waitForTimeout(1500); } catch(e) {}
    await page.goto(`https://asesdelnorte.com/NewAdmin/Jugadores.php?usr=${usuarioCasino}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.click('img[src*="cargarsaldo"]');
    await page.waitForTimeout(3000);
    const cargarFrame = page.frames().find(f => f.url().includes('carga-jugador'));
    if (!cargarFrame) return { exito: false, error: 'No se encontró el frame de carga' };
    await cargarFrame.fill('input[name="importe"]', String(monto));
    await cargarFrame.click('input[type="image"]');
    await page.waitForTimeout(3000);
    const url = page.url();
    const exito = url.includes('Carga%20exitosa') || url.includes('carga');
    return { exito };
  } catch (err) {
    console.error('❌ Error acreditando fichas:', err.message);
    return { exito: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── PROCESAR MENSAJE ─────────────────────────────────────────────────────────
async function procesarMensaje(chatId, telegramId, texto, foto) {
  try {
    let jugador = await Jugador.findOne({ telegramId });
    if (!jugador) jugador = await Jugador.create({ telegramId, estado: 'nuevo', historial: [] });

    await enviarTyping(chatId);

    // ── COMPROBANTE (foto) ────────────────────────────────────────────────────
    if (foto && jugador.estado === 'esperando_comprobante') {
      try {
        const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${foto}`);
        const filePath = fileInfo.data.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
        await Transaccion.create({ telegramId, monto: 0, estado: 'revision_manual', imagenUrl: fileUrl });
        jugador.estado = 'activo';
        await jugador.save();
        await enviarMensaje(chatId, '✅ comprobante recibido! en unos minutos te confirmamos la acreditación');
      } catch(e) {
        console.error('Error procesando imagen:', e);
        await enviarMensaje(chatId, 'no pude recibir la imagen, la podés mandar de nuevo?');
      }
      return;
    }

    if (!texto) return;
    let respuesta = '';

    // ── JUGADOR NUEVO ─────────────────────────────────────────────────────────
    if (jugador.estado === 'nuevo') {
      jugador.estado = 'esperando_nombre';
      await jugador.save();
      respuesta = 'hola! bienvenido 🎰 para crear tu cuenta necesito tu nombre, cómo te llamás?';

    // ── ESPERANDO NOMBRE ──────────────────────────────────────────────────────
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
          respuesta = `listo! tu cuenta está creada 🎉\n\n👤 Usuario: *${result.usuario}*\n🔑 Contraseña: *${result.contrasenia}*\n\n🌐 asesdelnorte.com\n\nPara cargar fichas transferís al alias *${process.env.CBU_ALIAS}* mínimo $${process.env.MONTO_MINIMO || 3000} y me mandás el comprobante 📸`;
        } else {
          jugador.estado = 'activo';
          await jugador.save();
          respuesta = `listo ${nombre}! en un momento te mandamos tus datos de acceso 🎰`;
        }
      }

    // ── CREANDO CUENTA (esperando) ────────────────────────────────────────────
    } else if (jugador.estado === 'creando_cuenta') {
      respuesta = 'dame un momento que estoy creando tu cuenta... ⏳';

    // ── ESPERANDO COMPROBANTE ─────────────────────────────────────────────────
    } else if (jugador.estado === 'esperando_comprobante') {
      respuesta = `mandame el comprobante de la transferencia al alias *${process.env.CBU_ALIAS}* 📸`;

    // ── JUGADOR ACTIVO ────────────────────────────────────────────────────────
    } else if (jugador.estado === 'activo') {

      if (texto.match(/deposit|cargar|fichas|pagar|transferi|quiero cargar|como cargo|cómo cargo|saldo|sii|siii|si quiero|dale|quiero jugar/i)) {
        jugador.estado = 'esperando_comprobante';
        await jugador.save();
        respuesta = `dale! transferís al alias:\n\n*${process.env.CBU_ALIAS}*\n\nmínimo $${process.env.MONTO_MINIMO || 3000} - cuando hayas hecho la transf mandame el comprobante acá 📸`;

      } else if (texto.match(/hola|buenas|buenos|hi|hey/i) && jugador.usuarioCasino) {
        respuesta = `hola ${jugador.nombre || ''}! 👋 tu cuenta es *${jugador.usuarioCasino}*. ¿Querés cargar fichas?`;

      } else {
        jugador.historial.push({ rol: 'user', contenido: texto });
        if (jugador.historial.length > 20) jugador.historial.shift();
        respuesta = await responderConIA(jugador, texto);
        jugador.historial.push({ rol: 'assistant', contenido: respuesta });
        await jugador.save();
      }

    // ── CUALQUIER OTRO ESTADO ─────────────────────────────────────────────────
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
  const message = update.message || update.edited_message;
  if (!message) return;
  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const texto = message.text || '';
  let fotoFileId = null;
  if (message.photo && message.photo.length > 0) {
    fotoFileId = message.photo[message.photo.length - 1].file_id;
  }
  await procesarMensaje(chatId, telegramId, texto, fotoFileId);
});

// ─── ENDPOINTS PANEL ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🎰 Nebula Casino Backend funcionando'));

app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

app.get('/jugadores', async (req, res) => {
  try {
    const jugadores = await Jugador.find({}).sort({ creadoEn: -1 });
    res.json(jugadores);
  } catch(e) { res.status(500).json([]); }
});

app.get('/transacciones', async (req, res) => {
  try {
    const trans = await Transaccion.find().sort({ creadoEn: -1 }).limit(200);
    res.json(trans);
  } catch(e) { res.status(500).json([]); }
});

app.post('/acreditar-manual', async (req, res) => {
  const { id, telegramId, usuarioCasino, monto } = req.body;
  // Responder inmediatamente al panel
  res.json({ exito: true });
  // Acreditar en background
  Transaccion.findByIdAndUpdate(id, { estado: 'procesando', monto })
    .then(() => acreditarFichas(usuarioCasino, monto))
    .then(async result => {
      if (result.exito) {
        await Transaccion.findByIdAndUpdate(id, { estado: 'acreditado' });
        await enviarMensaje(telegramId, `listo! te acredité *$${Number(monto).toLocaleString('es-AR')}* en tu cuenta 🎰 ya podés jugar!`);
      } else {
        await Transaccion.findByIdAndUpdate(id, { estado: 'revision_manual' });
        console.error('Error acreditando:', result.error);
      }
    })
    .catch(e => console.error('Error en acreditación background:', e.message));
});

app.post('/rechazar-transaccion', async (req, res) => {
  const { id } = req.body;
  try {
    await Transaccion.findByIdAndUpdate(id, { estado: 'rechazado' });
    res.json({ exito: true });
  } catch(e) { res.status(500).json({ exito: false, error: e.message }); }
});

// ─── INICIAR ──────────────────────────────────────────────────────────────────
app.listen(port, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${port}`);
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: `https://gustavoases.com/telegram` });
    console.log('✅ Webhook Telegram configurado');
  } catch (err) {
    console.error('❌ Error configurando webhook Telegram:', err.message);
  }
});
