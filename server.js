require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json({ limit: '20mb' }));

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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function procesarMensajeConIA(jugador, mensajeUsuario) {
  const systemPrompt = `Sos el asistente virtual de un casino online argentino. Tu nombre es Nova.
Atendés jugadores por WhatsApp en español argentino informal (tuteo).
Alias para transferencias: ${process.env.CBU_ALIAS}
Monto mínimo: $${process.env.MONTO_MINIMO || 1000}
Jugador: ${jugador.nombre || 'desconocido'}, estado: ${jugador.estado}
Mensajes cortos, máximo 3 párrafos, 1-2 emojis. Respondé SOLO el mensaje para el jugador.`;

  const mensajes = [
    ...jugador.historial.map(h => ({ role: h.rol, content: h.contenido })),
    { role: 'user', content: mensajeUsuario },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: mensajes,
  });
  return response.content[0].text;
}

let qrImageBase64 = null;
let waConnected = false;

const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: '/root/.wwebjs_auth' }),
  puppeteer: {
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  },
});

waClient.on('qr', async qr => {
  console.log('📱 QR generado - visitá /qr para escanearlo');
  qrcode.generate(qr, { small: true });
  try {
    qrImageBase64 = await QRCode.toDataURL(qr);
  } catch(e) {
    console.error('Error generando QR imagen:', e);
  }
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

    if (msg.hasMedia && jugador.estado === 'esperando_comprobante') {
      await waClient.sendMessage(msg.from, '🔍 Analizando tu comprobante...');
      try {
        const media = await msg.downloadMedia();
        const { montoDetectado, cbuVerificado, texto } = await extraerMontoDeComprobante(media.data);
        const transaccion = await Transaccion.create({ telefono, monto: montoDetectado, textoOCR: texto, estado: 'revision_manual' });

        if (!montoDetectado) {
          respuesta = '❌ No pude detectar el monto. ¿Podés mandar una foto más clara?';
          await transaccion.updateOne({ estado: 'rechazado' });
        } else if (!cbuVerificado) {
          respuesta = `⚠️ No veo transferencia a nuestro alias *${process.env.CBU_ALIAS}*. ¿Verificás que hayas transferido al alias correcto?`;
          await transaccion.updateOne({ estado: 'rechazado' });
        } else {
          const operador = process.env.OPERADOR_TELEFONO;
          if (operador) {
            await waClient.sendMessage(`${operador}@c.us`, `🔔 *DEPÓSITO PARA ACREDITAR*\n\n👤 ${jugador.nombre || telefono}\n📱 ${telefono}\n🎰 Usuario: ${jugador.usuarioCasino || 'sin cuenta'}\n💰 Monto: $${Number(montoDetectado).toLocaleString('es-AR')}\n\nAcreditá en el casino y confirmá desde el panel.`);
          }
          jugador.estado = 'activo';
          await jugador.save();
          respuesta = `✅ Comprobante recibido por *$${Number(montoDetectado).toLocaleString('es-AR')}*. Estamos verificando y en minutos te confirmamos la acreditación ⏳`;
        }
      } catch(e) {
        respuesta = '❌ No pude procesar la imagen. ¿La podés mandar de nuevo?';
      }
      await waClient.sendMessage(msg.from, respuesta);
      return;
    }

    const texto = msg.body?.trim() || '';
    if (!texto) return;

    if (jugador.estado === 'nuevo' && texto.match(/registr|cuenta|crear|quiero jugar|empezar|hola|buenas|info/i)) {
      jugador.estado = 'esperando_nombre';
      await jugador.save();
      respuesta = '¡Hola! Bienvenido 🎰 Para crear tu cuenta necesito tu nombre. ¿Cómo te llamás?';

    } else if (jugador.estado === 'esperando_nombre') {
      const nombre = texto.replace(/[^a-záéíóúñA-ZÁÉÍÓÚÑ\s]/g, '').trim();
      if (nombre.length < 2) {
        respuesta = 'No entendí tu nombre. ¿Me lo podés escribir de nuevo?';
      } else {
        jugador.nombre = nombre;
        jugador.estado = 'activo';
        await jugador.save();
        const operador = process.env.OPERADOR_TELEFONO;
        if (operador) {
          await waClient.sendMessage(`${operador}@c.us`, `🆕 *NUEVO JUGADOR*\n\n👤 Nombre: ${nombre}\n📱 Tel: ${telefono}\n\nCreá la cuenta en el casino.`);
        }
        respuesta = `¡Perfecto, ${nombre}! 🎉 Tu cuenta está siendo creada. En unos minutos te mandamos tus datos de acceso.\n\n¿Querés saber cómo hacer tu primer depósito?`;
      }

    } else if (texto.match(/deposit|cargar|fichas|pagar|transferi|quiero cargar/i)) {
      jugador.estado = 'esperando_comprobante';
      await jugador.save();
      respuesta = `💳 Para depositar transferí al alias:\n\n*${process.env.CBU_ALIAS}*\n\nMínimo: $${Number(process.env.MONTO_MINIMO || 1000).toLocaleString('es-AR')}\n\nCuando hagas la transferencia mandame el comprobante 📸`;

    } else {
      jugador.historial.push({ rol: 'user', contenido: texto });
      if (jugador.historial.length > 20) jugador.historial.shift();
      respuesta = await procesarMensajeConIA(jugador, texto);
      jugador.historial.push({ rol: 'assistant', contenido: respuesta });
      await jugador.save();
    }

    if (respuesta) await waClient.sendMessage(msg.from, respuesta);

  } catch (err) {
    console.error('❌ Error:', err);
    await waClient.sendMessage(msg.from, '⚠️ Error técnico. Intentá de nuevo.');
  }
});

waClient.initialize();

app.get('/', (req, res) => res.send('🎰 Nebula Casino Bot funcionando'));

app.get('/qr', (req, res) => {
  if (waConnected) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:white"><h2 style="color:#22d87a">✅ WhatsApp conectado</h2><p>El bot está funcionando.</p></body></html>`);
  }
  if (!qrImageBase64) {
    return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:white"><h2>⏳ Generando QR...</h2><p>Esta página se actualiza sola.</p></body></html>`);
  }
  res.send(`<html><head><meta http-equiv="refresh" content="30"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:white"><h2 style="color:#7c6dfa">📱 Escanea con WhatsApp</h2><p>Abrí WhatsApp → Dispositivos vinculados → Vincular dispositivo</p><img src="${qrImageBase64}" style="width:300px;height:300px;border-radius:12px;margin:20px auto;display:block"/><p style="color:#6b6b80;font-size:13px">El QR expira en 60 segundos.</p></body></html>`);
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
    await Transaccion.findOneAndUpdate({ telefono, estado: 'revision_manual' }, { estado: 'acreditado' }, { sort: { creadoEn: -1 } });
    await waClient.sendMessage(`${telefono}@c.us`, `✅ ¡Fichas acreditadas! Se cargaron *$${Number(monto).toLocaleString('es-AR')}* en tu cuenta. ¡Buena suerte! 🎰`);
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.post('/rechazar-transaccion', async (req, res) => {
  const { id, telefono } = req.body;
  try {
    await Transaccion.findByIdAndUpdate(id, { estado: 'rechazado' });
    await waClient.sendMessage(`${telefono}@c.us`, '❌ Tu comprobante fue rechazado. Si creés que es un error escribinos.');
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.listen(port, () => console.log(`🚀 Servidor corriendo en puerto ${port}`));
