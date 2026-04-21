require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json({ limit: '20mb' }));

// ─── MONGODB ─────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ MongoDB conectado')).catch(err => console.error('❌ MongoDB error:', err));

const jugadorSchema = new mongoose.Schema({
  telefono:      { type: String, unique: true },
  nombre:        String,
  usuarioCasino: String,
  estado:        { type: String, default: 'nuevo' },
  historial:     [{ rol: String, contenido: String }],
  creadoEn:      { type: Date, default: Date.now },
});
const Jugador = mongoose.model('Jugador', jugadorSchema);

const transaccionSchema = new mongoose.Schema({
  telefono: String,
  monto:    Number,
  estado:   { type: String, default: 'pendiente' },
  textoOCR: String,
  creadoEn: { type: Date, default: Date.now },
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

// ─── WHAPIFY API ──────────────────────────────────────────────────────────────
async function enviarMensajeWhapify(userId, mensaje) {
  try {
    await axios.post('https://ap.whapify.ai/api/v1/send-message', {
      user_id: userId,
      message: mensaje
    }, {
      headers: { 'Authorization': `Bearer ${process.env.WHAPIFY_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Error enviando mensaje Whapify:', err.message);
  }
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

// ─── WEBHOOK DE WHAPIFY ───────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.json({ ok: true }); // Responder rápido a Whapify
  
  console.log('📩 Webhook recibido:', JSON.stringify(req.body).substring(0, 200));
  
  const body = req.body;
  const telefono = body.phone || body.whatsapp || body.contact_phone || body.user_phone || '';
  const userId = body.id || body.user_id || body.contact_id || '';
  const mensaje = body.last_message || body.message || body.text || '';
  const tieneImagen = body.has_media || body.media_url || false;

  if (!userId && !telefono) {
    console.log('⚠️ Sin userId ni telefono en webhook');
    return;
  }

  const identificador = telefono || userId;

  try {
    let jugador = await Jugador.findOne({ telefono: identificador });
    if (!jugador) jugador = await Jugador.create({ telefono: identificador, estado: 'nuevo', historial: [] });

    let respuesta = '';

    // Comprobante de pago
    if (tieneImagen && jugador.estado === 'esperando_comprobante') {
      const mediaUrl = body.media_url || '';
      if (mediaUrl) {
        await enviarMensajeWhapify(userId, '👀 vi el comprobante, lo estoy revisando...');
        // Descargar imagen y procesar con OCR
        try {
          const imgResp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
          const base64 = Buffer.from(imgResp.data).toString('base64');
          const { montoDetectado, cbuVerificado } = await extraerMonto(base64);
          
          if (!montoDetectado) {
            respuesta = 'mmm no pude leer bien el comprobante, lo podés mandar de nuevo?';
          } else if (!cbuVerificado) {
            respuesta = `no veo transferencia al alias *${process.env.CBU_ALIAS}*, revisá que hayas mandado al alias correcto`;
          } else {
            await enviarMensajeWhapify(userId, `joya! comprobante por *$${Number(montoDetectado).toLocaleString('es-AR')}* recibido ✅ acreditando...`);
            const result = await acreditarFichas(jugador.usuarioCasino, montoDetectado);
            await Transaccion.create({ telefono: identificador, monto: montoDetectado, estado: result.exito ? 'acreditado' : 'revision_manual' });
            jugador.estado = 'activo';
            await jugador.save();
            respuesta = result.exito 
              ? `listo! te acredité *$${Number(montoDetectado).toLocaleString('es-AR')}* en la cuenta 🎰 ya podés jugar!`
              : `recibí el comprobante ✅ en unos minutos te confirmamos la acreditación`;
          }
        } catch(e) {
          respuesta = 'no pude procesar la imagen, la podés mandar de nuevo?';
        }
        await enviarMensajeWhapify(userId, respuesta);
        return;
      }
    }

    // Mensajes de texto
    const texto = mensaje.trim();
    if (!texto) return;

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
        await enviarMensajeWhapify(userId, `perfecto ${nombre}! creando tu cuenta, dame un segundo... 🎰`);
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

    } else if (texto.match(/deposit|cargar|fichas|pagar|transferi|quiero cargar|cómo cargo|como cargo|saldo/i)) {
      jugador.estado = 'esperando_comprobante';
      await jugador.save();
      respuesta = `dale! transferís al alias:\n\n*${process.env.CBU_ALIAS}*\n\nmínimo $${process.env.MONTO_MINIMO || 3000} - cuando hagas la transf mandame el comprobante 📸`;

    } else if (jugador.estado === 'activo' && texto.match(/hola|buenas|buenos|hi|hey/i) && jugador.usuarioCasino) {
      respuesta = `hola ${jugador.nombre || ''}! 👋 ya tenés tu cuenta *${jugador.usuarioCasino}*. ¿Querés cargar fichas?`;

    } else {
      jugador.historial.push({ rol: 'user', contenido: texto });
      if (jugador.historial.length > 20) jugador.historial.shift();
      respuesta = await responderConIA(jugador, texto);
      jugador.historial.push({ rol: 'assistant', contenido: respuesta });
      await jugador.save();
    }

    if (respuesta) await enviarMensajeWhapify(userId, respuesta);

  } catch (err) {
    console.error('❌ Error webhook:', err);
  }
});

// ─── MCP ─────────────────────────────────────────────────────────────────────
app.get('/mcp', (req, res) => {
  res.json({
    name: 'Nebula Casino Tools', version: '1.0.0',
    tools: [
      { name: 'verificar_comprobante', description: 'Verifica un comprobante de transferencia bancaria', inputSchema: { type: 'object', properties: { imagen_base64: { type: 'string' }, telefono: { type: 'string' } }, required: ['imagen_base64', 'telefono'] } },
      { name: 'crear_usuario', description: 'Crea un nuevo usuario en el casino', inputSchema: { type: 'object', properties: { nombre: { type: 'string' }, telefono: { type: 'string' } }, required: ['nombre', 'telefono'] } },
      { name: 'acreditar_fichas', description: 'Acredita fichas en la cuenta del casino', inputSchema: { type: 'object', properties: { usuario_casino: { type: 'string' }, monto: { type: 'number' }, telefono: { type: 'string' } }, required: ['usuario_casino', 'monto', 'telefono'] } },
      { name: 'buscar_jugador', description: 'Busca un jugador por teléfono', inputSchema: { type: 'object', properties: { telefono: { type: 'string' } }, required: ['telefono'] } }
    ]
  });
});

app.post('/mcp', async (req, res) => {
  const { tool, input } = req.body;
  console.log(`🔧 MCP: ${tool}`);
  try {
    switch (tool) {
      case 'verificar_comprobante': {
        const { montoDetectado, cbuVerificado } = await extraerMonto(input.imagen_base64);
        await Transaccion.create({ telefono: input.telefono, monto: montoDetectado, estado: montoDetectado && cbuVerificado ? 'revision_manual' : 'rechazado' });
        return res.json({ success: true, resultado: { monto_detectado: montoDetectado, alias_verificado: cbuVerificado, valido: !!(montoDetectado && cbuVerificado) } });
      }
      case 'crear_usuario': {
        let jugador = await Jugador.findOne({ telefono: input.telefono });
        if (!jugador) jugador = await Jugador.create({ telefono: input.telefono, nombre: input.nombre, estado: 'creando_cuenta' });
        const num = await obtenerSiguienteNumero();
        const result = await crearUsuario(input.nombre, num);
        if (result.exito) await Jugador.findOneAndUpdate({ telefono: input.telefono }, { usuarioCasino: result.usuario, estado: 'activo', nombre: input.nombre });
        return res.json({ success: result.exito, resultado: result });
      }
      case 'acreditar_fichas': {
        const result = await acreditarFichas(input.usuario_casino, input.monto);
        if (result.exito) await Transaccion.findOneAndUpdate({ telefono: input.telefono, estado: 'revision_manual' }, { estado: 'acreditado' }, { sort: { creadoEn: -1 } });
        return res.json({ success: result.exito, resultado: result });
      }
      case 'buscar_jugador': {
        const jugador = await Jugador.findOne({ telefono: input.telefono });
        return res.json({ success: true, resultado: jugador ? { existe: true, nombre: jugador.nombre, usuario_casino: jugador.usuarioCasino, estado: jugador.estado } : { existe: false } });
      }
      default: return res.status(400).json({ success: false, error: 'Herramienta desconocida' });
    }
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── PANEL ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🎰 Nebula Casino Backend funcionando'));
app.get('/panel', (req, res) => { const path = require('path'); res.sendFile(path.join(__dirname, 'panel.html')); });
app.get('/jugadores', async (req, res) => res.json(await Jugador.find({}).sort({ creadoEn: -1 })));
app.get('/transacciones', async (req, res) => res.json(await Transaccion.find().sort({ creadoEn: -1 }).limit(100)));

app.listen(port, () => console.log(`🚀 Servidor corriendo en puerto ${port}`));
