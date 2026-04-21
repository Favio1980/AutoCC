require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json({ limit: '20mb' }));

// ─── MONGODB ─────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB error:', err));

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

const contadorSchema = new mongoose.Schema({
  nombre: { type: String, unique: true },
  valor:  { type: Number, default: 0 },
});
const Contador = mongoose.model('Contador', contadorSchema);

async function obtenerSiguienteNumero() {
  const contador = await Contador.findOneAndUpdate(
    { nombre: 'jugadores' },
    { $inc: { valor: 1 } },
    { new: true, upsert: true }
  );
  return contador.valor;
}

// ─── GOOGLE VISION OCR ───────────────────────────────────────────────────────
let visionClient;
try {
  const credentials = JSON.parse(process.env.OCR_CREDENTIALS_JSON);
  visionClient = new vision.ImageAnnotatorClient({ credentials });
  console.log('✅ OCR inicializado');
} catch (err) {
  console.error('❌ OCR error:', err.message);
}

async function extraerMontoDeComprobante(base64Image) {
  try {
    const [result] = await visionClient.textDetection({ image: { content: base64Image } });
    const texto = result.textAnnotations.length ? result.textAnnotations[0].description : '';
    const patrones = [
      /\$\s*([\d.,]+)/g,
      /(?:monto|importe|total|transferencia|enviaste|recibiste)[:\s]*\$?\s*([\d.,]+)/gi,
      /(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?)/g,
    ];
    const montos = [];
    for (const patron of patrones) {
      let match;
      while ((match = patron.exec(texto)) !== null) {
        const num = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
        if (num > 100 && num < 10000000) montos.push(num);
      }
    }
    const alias = (process.env.CBU_ALIAS || '').toLowerCase();
    const cbuVerificado = alias ? texto.toLowerCase().includes(alias) : false;
    return { texto, montoDetectado: montos.length > 0 ? Math.max(...montos) : null, cbuVerificado };
  } catch (err) {
    console.error('❌ Error OCR:', err.message);
    return { texto: '', montoDetectado: null, cbuVerificado: false };
  }
}

// ─── ANTHROPIC ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function procesarMensajeConIA(jugador, mensajeUsuario) {
  const systemPrompt = `Sos un operador humano de un casino online argentino. Tu nombre es Nova.
Atendés jugadores por WhatsApp. Sos joven, informal, amigable. Usás español rioplatense.
Alias para transferencias: ${process.env.CBU_ALIAS}
Monto mínimo: $${process.env.MONTO_MINIMO || 1000}
Jugador: ${jugador.nombre || 'desconocido'}, estado: ${jugador.estado}
IMPORTANTE: Escribí como una persona real. Frases cortas. Máximo 2-3 oraciones. 0-1 emojis.
Usá palabras como: dale, joya, re, obvio, buenas, che.
Respondé SOLO el mensaje para el jugador, sin explicaciones.`;

  const mensajes = [
    ...jugador.historial.map(h => ({ role: h.rol, content: h.contenido })),
    { role: 'user', content: mensajeUsuario },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: systemPrompt,
    messages: mensajes,
  });
  return response.content[0].text;
}

// ─── HELPERS HUMANOS ─────────────────────────────────────────────────────────
function delay(minSeg, maxSeg) {
  const ms = (Math.random() * (maxSeg - minSeg) + minSeg) * 1000;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tiempoEscritura(texto) {
  const palabras = texto.split(' ').length;
  const segundos = Math.min(Math.max(palabras * 0.3, 1.5), 6);
  return segundos * 1000;
}

async function enviarMensajeHumano(chat, texto) {
  await delay(1.5, 4);
  try {
    const chatObj = await waClient.getChatById(chat);
    await chatObj.sendStateTyping();
  } catch(e) {}
  await new Promise(resolve => setTimeout(resolve, tiempoEscritura(texto)));
  await waClient.sendMessage(chat, texto);
}

// ─── PLAYWRIGHT: CREAR USUARIO ───────────────────────────────────────────────
async function crearUsuarioEnCasino(nombre, numero) {
  const usuario = `Zzz${nombre}${numero}`;
  const contrasenia = '123';
  const email = `${usuario.toLowerCase()}@gmail.com`;

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    });
    const page = await browser.newPage();

    await page.goto('https://asesdelnorte.com/NewAdmin/', { waitUntil: 'networkidle' });
    await page.fill('input[name="idusuario"]', process.env.CASINO_ADMIN_USER);
    await page.fill('input[name="contrasenia"]', process.env.CASINO_ADMIN_PASS);
    await page.click('input[type="image"]');
    await page.waitForTimeout(3000);

    // Manejar popups de bienvenida
    for (let i = 0; i < 3; i++) {
      try {
        const continuar = await page.$('a:has-text("CONTINUAR"), a:has-text("HOME")');
        if (continuar) { await continuar.click(); await page.waitForTimeout(1000); }
      } catch(e) {}
    }

    await page.goto('https://asesdelnorte.com/NewAdmin/RegistroJugador.php', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    await page.fill('input[name="nombre"]', nombre);
    await page.fill('input[name="apellido"]', 'N');
    await page.fill('input[name="idusuario"]', usuario);
    await page.fill('input[name="contrasenia"]', contrasenia);
    await page.fill('input[name="contrasenia2"]', contrasenia);
    await page.fill('input[name="email"]', email);

    await page.click('input[type="image"]');
    await page.waitForTimeout(3000);

    const contenido = await page.content();
    const exito = contenido.toLowerCase().includes('creado') || contenido.toLowerCase().includes('xito');

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

    await page.goto('https://asesdelnorte.com/NewAdmin/', { waitUntil: 'networkidle' });
    await page.fill('input[name="idusuario"]', process.env.CASINO_ADMIN_USER);
    await page.fill('input[name="contrasenia"]', process.env.CASINO_ADMIN_PASS);
    await page.click('input[type="image"]');
    await page.waitForTimeout(3000);

    // Manejar popups
    for (let i = 0; i < 3; i++) {
      try {
        const continuar = await page.$('a:has-text("CONTINUAR"), a:has-text("HOME")');
        if (continuar) { await continuar.click(); await page.waitForTimeout(1000); }
      } catch(e) {}
    }

    // Ir a la página del jugador
    await page.goto(`https://asesdelnorte.com/NewAdmin/Jugadores.php?usr=${usuarioCasino}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Clickear Cargar Saldo en el iframe
    const frame = page.frames().find(f => f.url().includes('Jugadores') || f.url().includes('jugador'));
    if (frame) {
      await frame.click('text=Cargar');
    } else {
      await page.click('text=Cargar');
    }
    await page.waitForTimeout(2000);

    // Completar el popup de carga
    const cargarFrame = page.frames().find(f => f.url().includes('carga-jugador'));
    if (cargarFrame) {
      await cargarFrame.fill('input[name="importe"]', String(monto));
      await cargarFrame.click('input[type="image"]');
    }
    await page.waitForTimeout(2000);

    return { exito: true };
  } catch (err) {
    console.error('❌ Error acreditando fichas:', err.message);
    return { exito: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
let qrImageBase64 = null;
let waConnected = false;

const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: '/root/.wwebjs_auth' }),
  puppeteer: {
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

waClient.on('qr', async qr => {
  console.log('📱 QR generado - visitá /qr para escanearlo');
  qrcode.generate(qr, { small: true });
  try { qrImageBase64 = await QRCode.toDataURL(qr); } catch(e) {}
});

waClient.on('ready', () => {
  waConnected = true;
  qrImageBase64 = null;
  console.log('✅ WhatsApp conectado');
});

waClient.on('disconnected', () => {
  waConnected = false;
  console.log('❌ WhatsApp desconectado');
});

waClient.on('message', async msg => {
  if (msg.from.includes('@g.us')) return;
  const telefono = msg.from.replace('@c.us', '');

  try {
    let jugador = await Jugador.findOne({ telefono });
    if (!jugador) jugador = await Jugador.create({ telefono, estado: 'nuevo', historial: [] });

    let respuesta = '';

    // ── Comprobante ───────────────────────────────────────────────────────
    if (msg.hasMedia && jugador.estado === 'esperando_comprobante') {
      await delay(2, 4);
      await waClient.sendMessage(msg.from, '👀 vi el comprobante, lo estoy revisando...');

      try {
        const media = await msg.downloadMedia();
        const { montoDetectado, cbuVerificado, texto } = await extraerMontoDeComprobante(media.data);
        const transaccion = await Transaccion.create({ telefono, monto: montoDetectado, textoOCR: texto, estado: 'revision_manual' });

        if (!montoDetectado) {
          await delay(2, 3);
          respuesta = 'mmm no pude leer bien el comprobante, lo podés mandar de nuevo con mejor calidad?';
          await transaccion.updateOne({ estado: 'rechazado' });
        } else if (!cbuVerificado) {
          await delay(2, 3);
          respuesta = `che, no veo que la transferencia sea a nuestro alias *${process.env.CBU_ALIAS}* 🤔 revisá que hayas mandado al alias correcto`;
          await transaccion.updateOne({ estado: 'rechazado' });
        } else {
          await waClient.sendMessage(msg.from, `joya! comprobante recibido por *$${Number(montoDetectado).toLocaleString('es-AR')}* ✅ acreditando las fichas...`);

          const resultado = await acreditarFichas(jugador.usuarioCasino, montoDetectado);

          if (resultado.exito) {
            await transaccion.updateOne({ estado: 'acreditado' });
            jugador.estado = 'activo';
            await jugador.save();
            respuesta = `listo! te acredité *$${Number(montoDetectado).toLocaleString('es-AR')}* en tu cuenta 🎰 ya podés jugar!`;
          } else {
            const operador = process.env.OPERADOR_TELEFONO;
            if (operador) {
              await waClient.sendMessage(`${operador}@c.us`,
                `🔔 *DEPÓSITO PARA ACREDITAR MANUAL*\n\n👤 ${jugador.nombre}\n📱 ${telefono}\n🎰 Usuario: ${jugador.usuarioCasino}\n💰 Monto: $${Number(montoDetectado).toLocaleString('es-AR')}\n\n⚠️ El robot falló, acreditá manualmente.`
              );
            }
            respuesta = `recibí el comprobante por *$${Number(montoDetectado).toLocaleString('es-AR')}* ✅ en unos minutos te confirmamos la acreditación`;
          }
        }
      } catch(e) {
        console.error('Error imagen:', e);
        respuesta = 'no pude abrir la imagen, la podés mandar de nuevo?';
      }

      await enviarMensajeHumano(msg.from, respuesta);
      return;
    }

    // ── Texto ─────────────────────────────────────────────────────────────
    const texto = msg.body?.trim() || '';
    if (!texto) return;

    if (jugador.estado === 'nuevo' && texto.match(/registr|cuenta|crear|quiero jugar|empezar|hola|buenas|info|buenos/i)) {
      jugador.estado = 'esperando_nombre';
      await jugador.save();
      const saludos = [
        'hola! bienvenido 🎰 cómo te llamás para crear tu cuenta?',
        'buenas! para registrarte necesito tu nombre nomás, cómo te llamás?',
        'hola! para abrirte la cuenta decime tu nombre',
      ];
      respuesta = saludos[Math.floor(Math.random() * saludos.length)];

    } else if (jugador.estado === 'esperando_nombre') {
      const nombre = texto.replace(/[^a-záéíóúñA-ZÁÉÍÓÚÑ\s]/g, '').trim();
      if (nombre.length < 2) {
        respuesta = 'no entendí bien el nombre, me lo repetís?';
      } else {
        jugador.nombre = nombre;
        jugador.estado = 'creando_cuenta';
        await jugador.save();

        await enviarMensajeHumano(msg.from, `perfecto ${nombre}! ya te estoy creando la cuenta, dame un segundo... 🎰`);

        const numero = await obtenerSiguienteNumero();
        const resultado = await crearUsuarioEnCasino(nombre, numero);

        if (resultado.exito) {
          jugador.usuarioCasino = resultado.usuario;
          jugador.estado = 'activo';
          await jugador.save();
          respuesta = `listo! tu cuenta está creada 🎉\n\n👤 Usuario: *${resultado.usuario}*\n🔑 Contraseña: *${resultado.contrasenia}*\n\n🌐 Entrá en: asesdelnorte.com\n\nPara cargar fichas transferís al alias *${process.env.CBU_ALIAS}* y me mandás el comprobante 📸`;
        } else {
          jugador.estado = 'activo';
          await jugador.save();
          const operador = process.env.OPERADOR_TELEFONO;
          if (operador) {
            await waClient.sendMessage(`${operador}@c.us`,
              `🆕 *NUEVO JUGADOR - CREAR MANUAL*\n\n👤 Nombre: ${nombre}\n📱 Tel: ${telefono}\n⚠️ El robot falló, creá la cuenta manualmente.`
            );
          }
          respuesta = `listo ${nombre}! en un momento te mandamos tus datos de acceso 🎰`;
        }
      }

    } else if (texto.match(/deposit|cargar|fichas|pagar|transferi|quiero cargar|cómo cargo|como cargo/i)) {
      jugador.estado = 'esperando_comprobante';
      await jugador.save();
      respuesta = `dale! para cargar transferís al alias:\n\n*${process.env.CBU_ALIAS}*\n\nmínimo $${Number(process.env.MONTO_MINIMO || 1000).toLocaleString('es-AR')} - cuando hagas la transf mandame el comprobante acá 📸`;

    } else {
      jugador.historial.push({ rol: 'user', contenido: texto });
      if (jugador.historial.length > 20) jugador.historial.shift();
      respuesta = await procesarMensajeConIA(jugador, texto);
      jugador.historial.push({ rol: 'assistant', contenido: respuesta });
      await jugador.save();
    }

    await enviarMensajeHumano(msg.from, respuesta);

  } catch (err) {
    console.error('❌ Error:', err);
    await waClient.sendMessage(msg.from, 'perdón, tuve un problema técnico. lo intentás de nuevo?');
  }
});

waClient.initialize();

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🎰 Nebula Casino Bot funcionando'));

app.get('/qr', (req, res) => {
  if (waConnected) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:white"><h2 style="color:#22d87a">✅ WhatsApp conectado</h2></body></html>`);
  }
  if (!qrImageBase64) {
    return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:white"><h2>⏳ Generando QR...</h2><p>Esta página se actualiza sola.</p></body></html>`);
  }
  res.send(`<html><head><meta http-equiv="refresh" content="30"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:white"><h2 style="color:#7c6dfa">📱 Escanea con WhatsApp</h2><p>Abrí WhatsApp → Dispositivos vinculados → Vincular dispositivo</p><img src="${qrImageBase64}" style="width:300px;height:300px;border-radius:12px;margin:20px auto;display:block"/></body></html>`);
});

app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

app.get('/jugadores', async (req, res) => {
  const jugadores = await Jugador.find({}, '-historial').sort({ creadoEn: -1 });
  res.json(jugadores);
});

app.get('/transacciones', async (req, res) => {
  const trans = await Transaccion.find().sort({ creadoEn: -1 }).limit(100);
  res.json(trans);
});

app.post('/acreditar-manual', async (req, res) => {
  const { telefono, monto } = req.body;
  try {
    const jugador = await Jugador.findOne({ telefono });
    await Transaccion.findOneAndUpdate({ telefono, estado: 'revision_manual' }, { estado: 'acreditado' }, { sort: { creadoEn: -1 } });
    if (jugador) {
      const resultado = await acreditarFichas(jugador.usuarioCasino, monto);
      if (resultado.exito) {
        await waClient.sendMessage(`${telefono}@c.us`, `listo! te acredité *$${Number(monto).toLocaleString('es-AR')}* en la cuenta 🎰 buena suerte!`);
      }
    }
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.post('/rechazar-transaccion', async (req, res) => {
  const { id, telefono } = req.body;
  try {
    await Transaccion.findByIdAndUpdate(id, { estado: 'rechazado' });
    await waClient.sendMessage(`${telefono}@c.us`, 'che, el comprobante no lo pudimos verificar. si crees que es un error escribinos y lo vemos');
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.listen(port, () => console.log(`🚀 Servidor corriendo en puerto ${port}`));
