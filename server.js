require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json({ limit: '20mb' }));

// ─── MONGODB ────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB error:', err));

const jugadorSchema = new mongoose.Schema({
  telefono:   { type: String, unique: true },
  nombre:     String,
  usuarioCasino: String,
  estado:     { type: String, default: 'nuevo' },
  // estados: nuevo | esperando_nombre | esperando_comprobante | activo
  historial:  [{ rol: String, contenido: String }],
  creadoEn:   { type: Date, default: Date.now },
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

// ─── GOOGLE VISION OCR ──────────────────────────────────────────────────────
let visionClient;
try {
  const credentials = JSON.parse(process.env.OCR_CREDENTIALS_JSON);
  visionClient = new vision.ImageAnnotatorClient({ credentials });
  console.log('✅ OCR inicializado');
} catch (err) {
  console.error('❌ OCR error:', err.message);
}

// ─── ANTHROPIC (CEREBRO DEL BOT) ────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function procesarMensajeConIA(jugador, mensajeUsuario) {
  const systemPrompt = `Sos el asistente virtual de un casino online argentino. Tu nombre es Nova.
Tu trabajo es atender jugadores por WhatsApp de forma amable y en español argentino informal (tuteo).

DATOS DEL SISTEMA:
- CBU/Alias para transferencias: ${process.env.CBU_ALIAS}
- Monto mínimo de depósito: $${process.env.MONTO_MINIMO || 1000}

ESTADO ACTUAL DEL JUGADOR:
- Nombre: ${jugador.nombre || 'desconocido'}
- Estado: ${jugador.estado}
- Usuario casino: ${jugador.usuarioCasino || 'sin cuenta'}

INSTRUCCIONES SEGÚN ESTADO:
- Si estado es "nuevo": saludá y preguntá cómo lo podés ayudar. Ofrecé opciones: 1) Registrarse 2) Depositar 3) Consultas
- Si estado es "esperando_nombre": el mensaje que recibís ES el nombre del jugador. Confirmalo y decile que su cuenta está siendo creada.
- Si estado es "activo" y quiere depositar: explicale que transfiera al CBU/alias, luego mande el comprobante.
- Si estado es "esperando_comprobante": decile que está procesando el comprobante.

REGLAS:
- Nunca inventes información que no tenés.
- Si el jugador manda algo que no entendés, pedile que repita con más claridad.
- Siempre terminá los mensajes con algo que invite a seguir la conversación.
- Mensajes cortos y directos, máximo 3 párrafos.
- Usá emojis con moderación (1-2 por mensaje máximo).

Respondé SOLO el mensaje para el jugador, sin explicaciones adicionales.`;

  const mensajes = [
    ...jugador.historial.map(h => ({
      role: h.rol,
      content: h.contenido,
    })),
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

// ─── MERCADO PAGO: VERIFICAR PAGO ───────────────────────────────────────────
async function verificarPagoMP(monto) {
  try {
    const response = await axios.get(
      'https://api.mercadopago.com/v1/payments/search',
      {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
        params: {
          sort: 'date_created',
          criteria: 'desc',
          range: 'date_created',
          begin_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // últimas 2 horas
          end_date: new Date().toISOString(),
          status: 'approved',
        },
      }
    );

    const pagos = response.data.results || [];
    const pagoEncontrado = pagos.find(p =>
      Math.abs(p.transaction_amount - monto) < 10 // tolerancia de $10
    );

    return pagoEncontrado || null;
  } catch (err) {
    console.error('❌ Error MP:', err.message);
    return null;
  }
}

// ─── OCR: EXTRAER MONTO DEL COMPROBANTE ─────────────────────────────────────
async function extraerMontoDeComprobante(base64Image) {
  try {
    const [result] = await visionClient.textDetection({
      image: { content: base64Image },
    });
    const texto = result.textAnnotations.length
      ? result.textAnnotations[0].description
      : '';

    // Buscar montos en el texto (ej: $15.000, 15000, 15,000.00)
    const patrones = [
      /\$\s*([\d.,]+)/g,
      /(?:monto|importe|total|transferencia)[:\s]*\$?\s*([\d.,]+)/gi,
      /(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?)/g,
    ];

    const montos = [];
    for (const patron of patrones) {
      let match;
      while ((match = patron.exec(texto)) !== null) {
        const num = parseFloat(
          match[1].replace(/\./g, '').replace(',', '.')
        );
        if (num > 100 && num < 10000000) montos.push(num);
      }
    }

    // Verificar que el CBU destino aparezca en el texto
    const cbu = process.env.CBU_ALIAS || '';
    const cbuEnTexto = texto.toLowerCase().includes(cbu.toLowerCase());

    return {
      texto,
      montos,
      montoDetectado: montos.length > 0 ? Math.max(...montos) : null,
      cbuVerificado: cbuEnTexto,
    };
  } catch (err) {
    console.error('❌ Error OCR:', err.message);
    return { texto: '', montos: [], montoDetectado: null, cbuVerificado: false };
  }
}

// ─── PLAYWRIGHT: CREAR USUARIO EN PLATAFORMA ────────────────────────────────
async function crearUsuarioEnPlataforma(nombre, telefono) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Login al panel admin
    await page.goto(process.env.CASINO_ADMIN_URL);
    await page.fill(process.env.CASINO_SELECTOR_USUARIO, process.env.CASINO_ADMIN_USER);
    await page.fill(process.env.CASINO_SELECTOR_PASSWORD, process.env.CASINO_ADMIN_PASS);
    await page.click(process.env.CASINO_SELECTOR_BTN_LOGIN);
    await page.waitForNavigation();

    // Ir a crear usuario
    await page.goto(process.env.CASINO_URL_CREAR_USUARIO);
    await page.fill(process.env.CASINO_SELECTOR_NOMBRE, nombre);
    await page.fill(process.env.CASINO_SELECTOR_TELEFONO, telefono);

    // Generar contraseña automática
    const password = 'Pass' + Math.random().toString(36).slice(2, 8).toUpperCase();
    if (process.env.CASINO_SELECTOR_PASS_NUEVO) {
      await page.fill(process.env.CASINO_SELECTOR_PASS_NUEVO, password);
    }

    await page.click(process.env.CASINO_SELECTOR_BTN_CREAR);
    await page.waitForTimeout(2000);

    // Obtener usuario generado (ajustar selector según plataforma)
    let usuarioGenerado = telefono; // fallback: usar teléfono como usuario
    if (process.env.CASINO_SELECTOR_USUARIO_GENERADO) {
      usuarioGenerado = await page.textContent(process.env.CASINO_SELECTOR_USUARIO_GENERADO);
    }

    return { exito: true, usuario: usuarioGenerado, password };
  } catch (err) {
    console.error('❌ Error Playwright crear usuario:', err.message);
    return { exito: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── PLAYWRIGHT: ACREDITAR FICHAS ───────────────────────────────────────────
async function acreditarFichas(usuarioCasino, monto) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(process.env.CASINO_ADMIN_URL);
    await page.fill(process.env.CASINO_SELECTOR_USUARIO, process.env.CASINO_ADMIN_USER);
    await page.fill(process.env.CASINO_SELECTOR_PASSWORD, process.env.CASINO_ADMIN_PASS);
    await page.click(process.env.CASINO_SELECTOR_BTN_LOGIN);
    await page.waitForNavigation();

    // Buscar usuario y acreditar
    await page.goto(process.env.CASINO_URL_DEPOSITO);
    await page.fill(process.env.CASINO_SELECTOR_BUSCAR_USUARIO, usuarioCasino);
    await page.click(process.env.CASINO_SELECTOR_BTN_BUSCAR);
    await page.waitForTimeout(1000);
    await page.fill(process.env.CASINO_SELECTOR_MONTO_DEPOSITO, String(monto));
    await page.click(process.env.CASINO_SELECTOR_BTN_CONFIRMAR_DEPOSITO);
    await page.waitForTimeout(2000);

    return { exito: true };
  } catch (err) {
    console.error('❌ Error Playwright acreditar:', err.message);
    return { exito: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── WHATSAPP BOT ───────────────────────────────────────────────────────────
const waClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

waClient.on('qr', qr => {
  console.log('\n📱 Escanea este QR con tu WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

waClient.on('ready', () => console.log('✅ WhatsApp conectado'));

waClient.on('message', async msg => {
  // Ignorar mensajes de grupos
  if (msg.from.includes('@g.us')) return;

  const telefono = msg.from.replace('@c.us', '');
  console.log(`📩 Mensaje de ${telefono}: ${msg.body?.substring(0, 50)}`);

  try {
    // Buscar o crear jugador
    let jugador = await Jugador.findOne({ telefono });
    if (!jugador) {
      jugador = await Jugador.create({ telefono, estado: 'nuevo', historial: [] });
    }

    let respuesta = '';

    // ── Manejo de imágenes (comprobantes) ──────────────────────────────────
    if (msg.hasMedia && jugador.estado === 'esperando_comprobante') {
      await waClient.sendMessage(msg.from, '🔍 Procesando tu comprobante, un momento...');

      const media = await msg.downloadMedia();
      if (!media) {
        respuesta = '❌ No pude leer la imagen. ¿Podés mandarla de nuevo?';
      } else {
        const { montoDetectado, cbuVerificado, texto } = await extraerMontoDeComprobante(media.data);

        // Guardar transacción
        await Transaccion.create({
          telefono,
          monto: montoDetectado,
          textoOCR: texto,
          estado: 'procesando',
        });

        if (!montoDetectado) {
          respuesta = '❌ No pude detectar el monto en el comprobante. ¿Podés mandar una foto más clara o el PDF?';
        } else if (!cbuVerificado) {
          respuesta = `⚠️ El comprobante no muestra transferencia a nuestro alias *${process.env.CBU_ALIAS}*. ¿Verificás que hayas transferido al alias correcto?`;
        } else {
          // Verificar contra MP
          const pagoMP = await verificarPagoMP(montoDetectado);

          if (pagoMP) {
            // Acreditar fichas
            const resultado = await acreditarFichas(jugador.usuarioCasino, montoDetectado);
            if (resultado.exito) {
              await Transaccion.findOneAndUpdate(
                { telefono, estado: 'procesando' },
                { estado: 'acreditado' }
              );
              respuesta = `✅ ¡Depósito confirmado! Se acreditaron *$${montoDetectado.toLocaleString('es-AR')}* en tu cuenta *${jugador.usuarioCasino}*. ¡Buena suerte! 🎰`;
              await jugador.updateOne({ estado: 'activo' });
            } else {
              respuesta = '⚠️ El pago fue verificado pero hubo un error al acreditar. Un operador te va a contactar en breve.';
            }
          } else {
            // Pago no encontrado en MP, podría ser válido pero demorado
            respuesta = `⏳ Detectamos un comprobante por *$${montoDetectado.toLocaleString('es-AR')}*. Estamos verificando el pago, en unos minutos te confirmamos la acreditación.`;
            // Guardar para revisión manual
            await Transaccion.findOneAndUpdate(
              { telefono, estado: 'procesando' },
              { estado: 'revision_manual' }
            );
          }
        }
      }

      await waClient.sendMessage(msg.from, respuesta);
      return;
    }

    // ── Manejo de texto ────────────────────────────────────────────────────
    const texto = msg.body?.trim() || '';

    // Detectar intención de registrarse
    if (jugador.estado === 'nuevo' &&
        (texto.match(/registr|cuenta|crear|quiero jugar|empezar/i))) {
      jugador.estado = 'esperando_nombre';
      await jugador.save();
      respuesta = '¡Genial! Para crear tu cuenta necesito tu nombre. ¿Cómo te llamás? 😊';

    // Capturar nombre
    } else if (jugador.estado === 'esperando_nombre') {
      const nombre = texto.replace(/[^a-záéíóúñA-ZÁÉÍÓÚÑ\s]/g, '').trim();
      if (nombre.length < 2) {
        respuesta = 'No entendí bien tu nombre. ¿Me lo podés escribir de nuevo?';
      } else {
        jugador.nombre = nombre;
        jugador.estado = 'creando_cuenta';
        await jugador.save();

        await waClient.sendMessage(msg.from, `⏳ Creando tu cuenta, *${nombre}*...`);

        const resultado = await crearUsuarioEnPlataforma(nombre, telefono);
        if (resultado.exito) {
          jugador.usuarioCasino = resultado.usuario;
          jugador.estado = 'activo';
          await jugador.save();
          respuesta = `✅ ¡Tu cuenta está lista, ${nombre}!\n\n👤 Usuario: *${resultado.usuario}*\n🔑 Contraseña: *${resultado.password}*\n\n¿Querés hacer tu primer depósito? 💰`;
        } else {
          jugador.estado = 'activo';
          await jugador.save();
          respuesta = `✅ ¡Bienvenido, ${nombre}! Tu cuenta fue registrada. Un operador te va a confirmar los datos de acceso en breve.`;
        }
      }

    // Detectar intención de depositar
    } else if (texto.match(/deposit|cargar|fichas|pagar|transferi/i)) {
      jugador.estado = 'esperando_comprobante';
      await jugador.save();
      respuesta = `💳 Para depositar, transferí el monto que quieras al siguiente alias:\n\n*${process.env.CBU_ALIAS}*\n\nEl mínimo es $${Number(process.env.MONTO_MINIMO || 1000).toLocaleString('es-AR')}.\n\nCuando hagas la transferencia, mandame el comprobante por acá 📸`;

    // Cualquier otro mensaje: responde la IA
    } else {
      // Actualizar historial
      jugador.historial.push({ rol: 'user', contenido: texto });
      if (jugador.historial.length > 20) jugador.historial.shift(); // mantener últimos 20

      respuesta = await procesarMensajeConIA(jugador, texto);

      jugador.historial.push({ rol: 'assistant', contenido: respuesta });
      await jugador.save();
    }

    if (respuesta) {
      await waClient.sendMessage(msg.from, respuesta);
    }

  } catch (err) {
    console.error('❌ Error procesando mensaje:', err);
    await waClient.sendMessage(msg.from, '⚠️ Hubo un error técnico. Por favor intentá de nuevo en un momento.');
  }
});

waClient.initialize();

// ─── ENDPOINTS REST ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🎰 Nebula Casino Bot funcionando'));

// OCR manual (para testing)
app.post('/ocr', async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: 'Falta base64' });
    const resultado = await extraerMontoDeComprobante(base64);
    res.json({ success: true, ...resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ver jugadores (para tu panel)
app.get('/jugadores', async (req, res) => {
  const jugadores = await Jugador.find({}, '-historial').sort({ creadoEn: -1 });
  res.json(jugadores);
});

// Ver transacciones pendientes
app.get('/transacciones', async (req, res) => {
  const trans = await Transaccion.find().sort({ creadoEn: -1 }).limit(50);
  res.json(trans);
});

// Acreditar manualmente (para casos que no se confirman automáticamente)
app.post('/acreditar-manual', async (req, res) => {
  const { telefono, monto } = req.body;
  const jugador = await Jugador.findOne({ telefono });
  if (!jugador) return res.status(404).json({ error: 'Jugador no encontrado' });

  const resultado = await acreditarFichas(jugador.usuarioCasino, monto);
  if (resultado.exito) {
    await waClient.sendMessage(`${telefono}@c.us`,
      `✅ Se acreditaron *$${Number(monto).toLocaleString('es-AR')}* en tu cuenta. ¡Buena suerte! 🎰`
    );
  }
  res.json(resultado);
});

// Rechazar transacción manualmente
app.post('/rechazar-transaccion', async (req, res) => {
  const { id, telefono } = req.body;
  await Transaccion.findByIdAndUpdate(id, { estado: 'rechazado' });
  await waClient.sendMessage(`${telefono}@c.us`,
    '❌ Tu comprobante fue rechazado. Si creés que es un error, escribinos y lo revisamos.'
  );
  res.json({ exito: true });
});

// Servir el panel de control
const path = require('path');
app.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

app.listen(port, () => console.log(`🚀 Servidor corriendo en puerto ${port}`));
