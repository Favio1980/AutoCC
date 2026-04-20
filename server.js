require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const pino = require('pino');
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

async function extraerMontoDeComprobante(buffer) {
  try {
    const base64 = buffer.toString('base64');
    const [result] = await visionClient.textDetection({ image: { content: base64 } });
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

let sock;

async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escanea este QR con tu WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(conectarWhatsApp, 3000);
    } else if (connection === 'open') {
      console.log('✅ WhatsApp conectado');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid.includes('@g.us')) continue;

      const telefono = msg.key.remoteJid.replace('@s.whatsapp.net', '');
      const tieneImagen = !!(msg.message?.imageMessage);
      const textoMensaje = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      try {
        let jugador = await Jugador.findOne({ telefono });
        if (!jugador) jugador = await Jugador.create({ telefono, estado: 'nuevo', historial: [] });

        let respuesta = '';

        if (tieneImagen && jugador.estado === 'esperando_comprobante') {
          await sock.sendMessage(msg.key.remoteJid, { text: '🔍 Analizando tu comprobante...' });
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const { montoDetectado, cbuVerificado, texto } = await extraerMontoDeComprobante(buffer);
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
                await sock.sendMessage(`${operador}@s.whatsapp.net`, {
                  text: `🔔 *DEPÓSITO PARA ACREDITAR*\n\n👤 ${jugador.nombre || telefono}\n📱 ${telefono}\n🎰 Usuario: ${jugador.usuarioCasino || 'sin cuenta'}\n💰 Monto: $${Number(montoDetectado).toLocaleString('es-AR')}\n\nAcreditá en el casino y confirmá desde el panel.`
                });
              }
              jugador.estado = 'activo';
              await jugador.save();
              respuesta = `✅ Comprobante recibido por *$${Number(montoDetectado).toLocaleString('es-AR')}*. Estamos verificando y en minutos te confirmamos la acreditación ⏳`;
            }
          } catch (e) {
            respuesta = '❌ No pude procesar la imagen. ¿La podés mandar de nuevo?';
          }
          await sock.sendMessage(msg.key.remoteJid, { text: respuesta });
          continue;
        }

        const texto = textoMensaje.trim();
        if (!texto) continue;

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
              await sock.sendMessage(`${operador}@s.whatsapp.net`, {
                text: `🆕 *NUEVO JUGADOR*\n\n👤 Nombre: ${nombre}\n📱 Tel: ${telefono}\n\nCreá la cuenta en el casino.`
              });
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

        if (respuesta) await sock.sendMessage(msg.key.remoteJid, { text: respuesta });

      } catch (err) {
        console.error('❌ Error:', err);
        await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Error técnico. Intentá de nuevo.' });
      }
    }
  });
}

conectarWhatsApp();

app.get('/', (req, res) => res.send('🎰 Nebula Casino Bot funcionando'));
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
    if (sock) await sock.sendMessage(`${telefono}@s.whatsapp.net`, { text: `✅ ¡Fichas acreditadas! Se cargaron *$${Number(monto).toLocaleString('es-AR')}* en tu cuenta. ¡Buena suerte! 🎰` });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});
app.post('/rechazar-transaccion', async (req, res) => {
  const { id, telefono } = req.body;
  try {
    await Transaccion.findByIdAndUpdate(id, { estado: 'rechazado' });
    if (sock) await sock.sendMessage(`${telefono}@s.whatsapp.net`, { text: '❌ Tu comprobante fue rechazado. Si creés que es un error escribinos.' });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.listen(port, () => console.log(`🚀 Servidor corriendo en puerto ${port}`));
