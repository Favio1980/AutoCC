require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const path = require('path');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json({ limit: '50mb' }));

// Directorio de comprobantes de retiros
const COMP_DIR = '/root/AutoCC/comprobantes_retiros';
if (!fs.existsSync(COMP_DIR)) fs.mkdirSync(COMP_DIR, { recursive: true });

// Multer para subir comprobantes
const storage = multer.diskStorage({
  destination: COMP_DIR,
  filename: (req, file, cb) => cb(null, `retiro_${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ─── MONGODB ──────────────────────────────────────────────────────────────────
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

const retiroSchema = new mongoose.Schema({
  telegramId:       String,
  nombreJugador:    String,
  usuarioCasino:    String,
  monto:            Number,
  cbu:              String,
  titular:          String,
  saldoCasino:      Number,
  estado:           { type: String, default: 'pendiente' },
  comprobanteUrl:   String,
  comprobanteLocal: String,
  creadoEn:         { type: Date, default: Date.now },
  auditoria:        [{ accion: String, fecha: Date, detalle: String }],
});
const Retiro = mongoose.model('Retiro', retiroSchema);

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

// ─── EMAIL ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});

async function enviarEmail(asunto, html) {
  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: asunto,
      html
    });
    console.log('✅ Email enviado');
  } catch(e) { console.error('❌ Error email:', e.message); }
}

// ─── ANTHROPIC ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function responderConIA(jugador, mensaje) {
  const system = `Sos Gustavo, operador de casino online argentino. Español rioplatense informal.
Casino: asesdelnorte.com y losasesdelnorte.com
Alias para transferencias: ${process.env.CBU_ALIAS}
Monto mínimo carga: $${process.env.MONTO_MINIMO || 3000}
Monto mínimo retiro: $${process.env.MONTO_MINIMO_RETIRO || 5000}
Jugador: ${jugador.nombre || 'desconocido'}, usuario: ${jugador.usuarioCasino || 'sin cuenta'}
Frases cortas. Máximo 2 oraciones. 0-1 emojis. Palabras: dale, joya, che, buenas.
NO inventes datos. NO pidas mail ni teléfono.
Para retiros el plazo es hasta 24hs hábiles.`;

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

async function enviarFoto(chatId, urlFoto, caption = '') {
  try {
    await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: chatId,
      photo: urlFoto,
      caption
    });
  } catch (err) {
    // Si falla con URL, intentar con archivo local
    console.error('❌ Error enviando foto:', err.message);
  }
}

async function enviarDocumento(chatId, filePath, caption = '') {
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('document', fs.createReadStream(filePath));
    await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
  } catch (err) {
    console.error('❌ Error enviando documento:', err.message);
  }
}

async function enviarTyping(chatId) {
  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
  } catch(e) {}
}

// ─── PLAYWRIGHT: LOGIN CASINO ─────────────────────────────────────────────────
async function loginCasino(page) {
  await page.goto('https://asesdelnorte.com/NewAdmin/login.php', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="nombreusuario"]', process.env.CASINO_ADMIN_USER);
  await page.fill('input[name="contrasenia"]', process.env.CASINO_ADMIN_PASS);
  await page.evaluate(() => document.querySelector('form').submit());
  await page.waitForTimeout(2000);
  try { await page.click('text=CONTINUAR', { timeout: 3000 }); await page.waitForTimeout(1500); } catch(e) {}
  try { await page.click('text=CONTINUAR', { timeout: 3000 }); await page.waitForTimeout(1500); } catch(e) {}
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
    await loginCasino(page);
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

// ─── PLAYWRIGHT: CONSULTAR SALDO ─────────────────────────────────────────────
async function consultarSaldo(usuarioCasino) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    });
    const page = await browser.newPage();
    await loginCasino(page);
    // Consultar saldo via API interna del casino
    const response = await page.goto(
      `https://asesdelnorte.com/NewAdmin/includes/getbalance.php?user=${usuarioCasino}&token=2026A`,
      { waitUntil: 'domcontentloaded' }
    );
    const texto = await page.textContent('body');
    // El saldo viene en el texto de la página
    const match = texto.match(/[\d.,]+/);
    const saldo = match ? parseFloat(match[0].replace(/\./g, '').replace(',', '.')) : 0;
    return { exito: true, saldo };
  } catch (err) {
    console.error('❌ Error consultando saldo:', err.message);
    return { exito: false, saldo: 0 };
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
    await loginCasino(page);
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
    return { exito: url.includes('Carga%20exitosa') || url.includes('carga') };
  } catch (err) {
    console.error('❌ Error acreditando fichas:', err.message);
    return { exito: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── PLAYWRIGHT: DESCONTAR FICHAS (RETIRO) ───────────────────────────────────
async function descontarFichas(usuarioCasino, monto) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    });
    const page = await browser.newPage();
    await loginCasino(page);
    await page.goto(`https://asesdelnorte.com/NewAdmin/Jugadores.php?usr=${usuarioCasino}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // Click en botón descargar saldo
    await page.click('img[src*="descargarsaldo"]');
    await page.waitForTimeout(3000);
    const descargarFrame = page.frames().find(f => f.url().includes('descarga-jugador') || f.url().includes('carga-jugador'));
    if (!descargarFrame) return { exito: false, error: 'No se encontró el frame de descarga' };
    await descargarFrame.fill('input[name="importe"]', String(monto));
    await descargarFrame.click('input[type="image"]');
    await page.waitForTimeout(3000);
    const url = page.url();
    return { exito: url.includes('exitosa') || url.includes('Descarga') || url.includes('Jugadores') };
  } catch (err) {
    console.error('❌ Error descontando fichas:', err.message);
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

    // ── COMPROBANTE DEPÓSITO ──────────────────────────────────────────────────
    if (foto && jugador.estado === 'esperando_comprobante') {
      try {
        const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${foto}`);
        const filePath = fileInfo.data.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
        await Transaccion.create({ telegramId, monto: 0, estado: 'revision_manual', imagenUrl: fileUrl });
        jugador.estado = 'activo';
        await jugador.save();
        await enviarMensaje(chatId, '✅ comprobante recibido! en unos minutos te confirmamos la acreditación');
        // Notificar por email
        enviarEmail(
          `🎰 Nuevo comprobante — ${jugador.nombre || telegramId}`,
          `<h2>Nuevo comprobante de pago</h2>
          <p><b>Jugador:</b> ${jugador.nombre || '—'}</p>
          <p><b>Usuario casino:</b> ${jugador.usuarioCasino || '—'}</p>
          <p><b>Telegram ID:</b> ${telegramId}</p>
          ${fileUrl ? `<p><b>Comprobante:</b> <a href="${fileUrl}">Ver imagen</a></p><img src="${fileUrl}" style="max-width:400px">` : ''}
          <p><a href="https://gustavoases.com/panel" style="background:#00ff88;padding:10px 20px;color:#000;text-decoration:none;font-weight:bold">Ir al Panel →</a></p>`
        );
      } catch(e) {
        console.error('Error procesando imagen:', e);
        await enviarMensaje(chatId, 'no pude recibir la imagen, la podés mandar de nuevo?');
      }
      return;
    }

    if (!texto) return;
    const MONTO_MIN_RETIRO = Number(process.env.MONTO_MINIMO_RETIRO || 5000);

    // ── FLUJO DE RETIRO ───────────────────────────────────────────────────────
    if (jugador.estado === 'retiro_monto') {
      const monto = parseFloat(texto.replace(/[^0-9.,]/g, '').replace(',', '.'));
      if (!monto || monto < MONTO_MIN_RETIRO) {
        await enviarMensaje(chatId, `el monto mínimo de retiro es $${MONTO_MIN_RETIRO.toLocaleString('es-AR')} 💰`);
        return;
      }
      jugador.estado = 'retiro_cbu';
      jugador.historial.push({ rol: 'retiro_monto_temp', contenido: String(monto) });
      await jugador.save();
      await enviarMensaje(chatId, `perfecto! $${monto.toLocaleString('es-AR')} ✅\n\nahora mandame tu CBU o alias de destino:`);
      return;
    }

    if (jugador.estado === 'retiro_cbu') {
      jugador.estado = 'retiro_titular';
      jugador.historial.push({ rol: 'retiro_cbu_temp', contenido: texto.trim() });
      await jugador.save();
      await enviarMensaje(chatId, 'y el nombre del titular de la cuenta?');
      return;
    }

    if (jugador.estado === 'retiro_titular') {
      // Recuperar monto y cbu guardados temporalmente
      const montoEntry = jugador.historial.slice().reverse().find(h => h.rol === 'retiro_monto_temp');
      const cbuEntry = jugador.historial.slice().reverse().find(h => h.rol === 'retiro_cbu_temp');
      const monto = parseFloat(montoEntry?.contenido || '0');
      const cbu = cbuEntry?.contenido || '';
      const titular = texto.trim();

      // Limpiar historial temporal
      jugador.historial = jugador.historial.filter(h => !h.rol.startsWith('retiro_'));

      // Crear solicitud de retiro
      const retiro = await Retiro.create({
        telegramId,
        nombreJugador: jugador.nombre,
        usuarioCasino: jugador.usuarioCasino,
        monto,
        cbu,
        titular,
        estado: 'pendiente',
        auditoria: [{ accion: 'creado', fecha: new Date(), detalle: `Jugador solicitó retiro de $${monto}` }]
      });

      jugador.estado = 'activo';
      await jugador.save();

      await enviarMensaje(chatId,
        `✅ solicitud de retiro registrada!\n\n💰 Monto: *$${monto.toLocaleString('es-AR')}*\n🏦 CBU/Alias: *${cbu}*\n👤 Titular: *${titular}*\n\nEl plazo de procesamiento es hasta 24hs hábiles. Te avisamos cuando esté listo 🎰`
      );

      // Notificar por email
      enviarEmail(
        `💸 Solicitud de RETIRO — ${jugador.nombre || telegramId} — $${monto.toLocaleString('es-AR')}`,
        `<h2>Nueva solicitud de retiro</h2>
        <p><b>Jugador:</b> ${jugador.nombre || '—'}</p>
        <p><b>Usuario casino:</b> ${jugador.usuarioCasino || '—'}</p>
        <p><b>Telegram ID:</b> ${telegramId}</p>
        <p><b>Monto:</b> $${monto.toLocaleString('es-AR')}</p>
        <p><b>CBU/Alias:</b> ${cbu}</p>
        <p><b>Titular:</b> ${titular}</p>
        <p><a href="https://gustavoases.com/panel" style="background:#ff3355;padding:10px 20px;color:#fff;text-decoration:none;font-weight:bold">Ver en Panel →</a></p>`
      );
      return;
    }

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

    } else if (jugador.estado === 'creando_cuenta') {
      respuesta = 'dame un momento que estoy creando tu cuenta... ⏳';

    } else if (jugador.estado === 'esperando_comprobante') {
      respuesta = `mandame el comprobante de la transferencia al alias *${process.env.CBU_ALIAS}* 📸`;

    } else if (jugador.estado === 'activo') {

      // Quiere cargar fichas
      if (texto.match(/deposit|cargar|fichas|pagar|transferi|quiero cargar|como cargo|cómo cargo|sii|siii|si quiero|dale|quiero jugar/i)) {
        jugador.estado = 'esperando_comprobante';
        await jugador.save();
        respuesta = `dale! transferís al alias:\n\n*${process.env.CBU_ALIAS}*\n\nmínimo $${process.env.MONTO_MINIMO || 3000} - cuando hayas hecho la transf mandame el comprobante acá 📸`;

      // Quiere retirar
      } else if (texto.match(/retir|cobrar|retirar|sacar|retirar fichas|quiero cobrar|quiero retirar/i)) {
        if (!jugador.usuarioCasino) {
          respuesta = 'primero tenés que tener una cuenta activa para retirar 😊';
        } else {
          jugador.estado = 'retiro_monto';
          await jugador.save();
          respuesta = `dale! ¿cuánto querés retirar? (mínimo $${MONTO_MIN_RETIRO.toLocaleString('es-AR')})`;
        }

      // Saludo
      } else if (texto.match(/hola|buenas|buenos|hi|hey/i) && jugador.usuarioCasino) {
        respuesta = `hola ${jugador.nombre || ''}! 👋 tu cuenta es *${jugador.usuarioCasino}*. ¿Querés cargar fichas o retirar?`;

      } else {
        jugador.historial.push({ rol: 'user', contenido: texto });
        if (jugador.historial.length > 20) jugador.historial.shift();
        respuesta = await responderConIA(jugador, texto);
        jugador.historial.push({ rol: 'assistant', contenido: respuesta });
        await jugador.save();
      }

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
  try { res.json(await Jugador.find({}).sort({ creadoEn: -1 })); }
  catch(e) { res.status(500).json([]); }
});

app.get('/transacciones', async (req, res) => {
  try { res.json(await Transaccion.find().sort({ creadoEn: -1 }).limit(200)); }
  catch(e) { res.status(500).json([]); }
});

app.get('/retiros', async (req, res) => {
  try { res.json(await Retiro.find().sort({ creadoEn: -1 }).limit(200)); }
  catch(e) { res.status(500).json([]); }
});

// Acreditar depósito
app.post('/acreditar-manual', async (req, res) => {
  const { id, telegramId, usuarioCasino, monto } = req.body;
  res.json({ exito: true });
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
    .catch(e => console.error('Error background acreditación:', e.message));
});

// Rechazar depósito
app.post('/rechazar-transaccion', async (req, res) => {
  const { id } = req.body;
  try {
    await Transaccion.findByIdAndUpdate(id, { estado: 'rechazado' });
    res.json({ exito: true });
  } catch(e) { res.status(500).json({ exito: false, error: e.message }); }
});

// Aprobar retiro → descontar fichas automáticamente
app.post('/aprobar-retiro', async (req, res) => {
  const { id } = req.body;
  res.json({ exito: true });
  Retiro.findById(id)
    .then(async retiro => {
      if (!retiro) return;
      await Retiro.findByIdAndUpdate(id, {
        estado: 'procesando',
        $push: { auditoria: { accion: 'aprobado', fecha: new Date(), detalle: 'Admin aprobó el retiro' } }
      });
      // Descontar fichas en el casino
      const result = await descontarFichas(retiro.usuarioCasino, retiro.monto);
      if (result.exito) {
        await Retiro.findByIdAndUpdate(id, {
          estado: 'fichas_descontadas',
          $push: { auditoria: { accion: 'fichas_descontadas', fecha: new Date(), detalle: `Se descontaron ${retiro.monto} fichas` } }
        });
        // Avisar al jugador
        await enviarMensaje(retiro.telegramId,
          `✅ tu solicitud de retiro por *$${Number(retiro.monto).toLocaleString('es-AR')}* fue aprobada!\n\nEstamos procesando la transferencia. En hasta 24hs hábiles te enviamos el comprobante 💸`
        );
      } else {
        await Retiro.findByIdAndUpdate(id, {
          estado: 'pendiente',
          $push: { auditoria: { accion: 'error', fecha: new Date(), detalle: `Error descontando fichas: ${result.error}` } }
        });
        console.error('Error descontando fichas:', result.error);
      }
    })
    .catch(e => console.error('Error aprobando retiro:', e.message));
});

// Rechazar retiro
app.post('/rechazar-retiro', async (req, res) => {
  const { id } = req.body;
  try {
    const retiro = await Retiro.findByIdAndUpdate(id, {
      estado: 'rechazado',
      $push: { auditoria: { accion: 'rechazado', fecha: new Date(), detalle: 'Admin rechazó el retiro' } }
    }, { new: true });
    res.json({ exito: true });
  } catch(e) { res.status(500).json({ exito: false, error: e.message }); }
});

// Subir comprobante de transferencia al jugador
app.post('/subir-comprobante-retiro', upload.single('comprobante'), async (req, res) => {
  const { id } = req.body;
  try {
    const retiro = await Retiro.findById(id);
    if (!retiro) return res.status(404).json({ exito: false });

    const filePath = req.file.path;
    const fileName = req.file.filename;

    await Retiro.findByIdAndUpdate(id, {
      estado: 'pagado',
      comprobanteLocal: filePath,
      $push: { auditoria: { accion: 'pagado', fecha: new Date(), detalle: `Comprobante subido: ${fileName}` } }
    });

    // Enviar comprobante al jugador por Telegram
    try {
      await enviarDocumento(
        retiro.telegramId,
        filePath,
        `✅ *Comprobante de retiro*\n💰 Monto: $${Number(retiro.monto).toLocaleString('es-AR')}\n🏦 CBU/Alias: ${retiro.cbu}\n👤 Titular: ${retiro.titular}\n\n¡Gracias por jugar en Ases del Norte! 🎰`
      );
    } catch(e) {
      // Si falla el documento, intentar como foto
      console.error('Error enviando documento, intentando foto:', e.message);
    }

    res.json({ exito: true });
  } catch(e) {
    console.error('Error subiendo comprobante:', e.message);
    res.status(500).json({ exito: false, error: e.message });
  }
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
