require('dotenv').config({ path: 'env.txt' });
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3002;
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
    for (let i = 0; i < 3; i++) {
      try {
        const continuar = await page.$('a:has-text("CONTINUAR"), a:has-text("HOME")');
        if (continuar) { await continuar.click(); await page.waitForTimeout(1000); }
      } catch(e) {}
    }
    await page.goto(`https://asesdelnorte.com/NewAdmin/Jugadores.php?usr=${usuarioCasino}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const frame = page.frames().find(f => f.url().includes('Jugadores') || f.url().includes('jugador'));
    if (frame) {
      await frame.click('text=Cargar');
    } else {
      await page.click('text=Cargar');
    }
    await page.waitForTimeout(2000);
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

// ─── MCP SERVER ──────────────────────────────────────────────────────────────
// Endpoint que Whapify llama para descubrir las herramientas disponibles
app.get('/mcp', (req, res) => {
  res.json({
    name: 'Nebula Casino Tools',
    version: '1.0.0',
    tools: [
      {
        name: 'verificar_comprobante',
        description: 'Verifica un comprobante de transferencia bancaria usando OCR. Recibe una imagen en base64 y devuelve el monto detectado y si el alias es correcto.',
        inputSchema: {
          type: 'object',
          properties: {
            imagen_base64: { type: 'string', description: 'Imagen del comprobante en base64' },
            telefono: { type: 'string', description: 'Número de teléfono del jugador' }
          },
          required: ['imagen_base64', 'telefono']
        }
      },
      {
        name: 'crear_usuario',
        description: 'Crea un nuevo usuario en el casino asesdelnorte.com. Devuelve el usuario y contraseña generados.',
        inputSchema: {
          type: 'object',
          properties: {
            nombre: { type: 'string', description: 'Nombre del jugador' },
            telefono: { type: 'string', description: 'Número de teléfono del jugador' }
          },
          required: ['nombre', 'telefono']
        }
      },
      {
        name: 'acreditar_fichas',
        description: 'Acredita fichas en la cuenta de un jugador en el casino.',
        inputSchema: {
          type: 'object',
          properties: {
            usuario_casino: { type: 'string', description: 'Usuario del jugador en el casino' },
            monto: { type: 'number', description: 'Monto a acreditar en pesos argentinos' },
            telefono: { type: 'string', description: 'Teléfono del jugador para registrar la transacción' }
          },
          required: ['usuario_casino', 'monto', 'telefono']
        }
      },
      {
        name: 'buscar_jugador',
        description: 'Busca información de un jugador por su número de teléfono.',
        inputSchema: {
          type: 'object',
          properties: {
            telefono: { type: 'string', description: 'Número de teléfono del jugador' }
          },
          required: ['telefono']
        }
      }
    ]
  });
});

// Endpoint que Whapify llama para ejecutar una herramienta
app.post('/mcp', async (req, res) => {
  const { tool, input } = req.body;
  console.log(`🔧 MCP tool llamada: ${tool}`, input);

  try {
    switch (tool) {

      case 'verificar_comprobante': {
        const { imagen_base64, telefono } = input;
        const { montoDetectado, cbuVerificado, texto } = await extraerMontoDeComprobante(imagen_base64);
        
        await Transaccion.create({
          telefono,
          monto: montoDetectado,
          textoOCR: texto,
          estado: montoDetectado && cbuVerificado ? 'revision_manual' : 'rechazado'
        });

        return res.json({
          success: true,
          resultado: {
            monto_detectado: montoDetectado,
            alias_verificado: cbuVerificado,
            alias_esperado: process.env.CBU_ALIAS,
            valido: !!(montoDetectado && cbuVerificado),
            mensaje: !montoDetectado 
              ? 'No se pudo leer el monto del comprobante'
              : !cbuVerificado 
                ? `El comprobante no muestra transferencia al alias ${process.env.CBU_ALIAS}`
                : `Comprobante válido por $${Number(montoDetectado).toLocaleString('es-AR')}`
          }
        });
      }

      case 'crear_usuario': {
        const { nombre, telefono } = input;
        
        let jugador = await Jugador.findOne({ telefono });
        if (!jugador) {
          jugador = await Jugador.create({ telefono, nombre, estado: 'creando_cuenta' });
        }

        const numero = await obtenerSiguienteNumero();
        const resultado = await crearUsuarioEnCasino(nombre, numero);

        if (resultado.exito) {
          await Jugador.findOneAndUpdate(
            { telefono },
            { usuarioCasino: resultado.usuario, estado: 'activo', nombre }
          );
        }

        return res.json({
          success: resultado.exito,
          resultado: resultado.exito ? {
            usuario: resultado.usuario,
            contrasenia: resultado.contrasenia,
            mensaje: `Cuenta creada exitosamente. Usuario: ${resultado.usuario}, Contraseña: ${resultado.contrasenia}`
          } : {
            error: resultado.error,
            mensaje: 'No se pudo crear la cuenta automáticamente. Se notificará al operador.'
          }
        });
      }

      case 'acreditar_fichas': {
        const { usuario_casino, monto, telefono } = input;
        const resultado = await acreditarFichas(usuario_casino, monto);

        if (resultado.exito) {
          await Transaccion.findOneAndUpdate(
            { telefono, estado: 'revision_manual' },
            { estado: 'acreditado' },
            { sort: { creadoEn: -1 } }
          );
        }

        return res.json({
          success: resultado.exito,
          resultado: {
            mensaje: resultado.exito 
              ? `Se acreditaron $${Number(monto).toLocaleString('es-AR')} en la cuenta ${usuario_casino}`
              : 'Error al acreditar fichas. Se notificará al operador manualmente.'
          }
        });
      }

      case 'buscar_jugador': {
        const { telefono } = input;
        const jugador = await Jugador.findOne({ telefono });
        
        return res.json({
          success: true,
          resultado: jugador ? {
            existe: true,
            nombre: jugador.nombre,
            usuario_casino: jugador.usuarioCasino,
            estado: jugador.estado,
            es_nuevo: jugador.estado === 'nuevo'
          } : {
            existe: false,
            es_nuevo: true,
            mensaje: 'Jugador nuevo, no tiene cuenta aún'
          }
        });
      }

      default:
        return res.status(400).json({ success: false, error: `Herramienta desconocida: ${tool}` });
    }
  } catch (err) {
    console.error('❌ Error en MCP:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINTS PANEL ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🎰 Nebula Casino Backend funcionando'));

app.get('/panel', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, 'panel.html'));
});

app.get('/jugadores', async (req, res) => {
  const jugadores = await Jugador.find({}).sort({ creadoEn: -1 });
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
    if (!jugador) return res.status(404).json({ error: 'Jugador no encontrado' });
    await Transaccion.findOneAndUpdate({ telefono, estado: 'revision_manual' }, { estado: 'acreditado' }, { sort: { creadoEn: -1 } });
    const resultado = await acreditarFichas(jugador.usuarioCasino, monto);
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ exito: false, error: e.message });
  }
});

app.post('/rechazar-transaccion', async (req, res) => {
  const { id } = req.body;
  try {
    await Transaccion.findByIdAndUpdate(id, { estado: 'rechazado' });
    res.json({ exito: true });
  } catch (e) {
    res.status(500).json({ exito: false, error: e.message });
  }
});

app.listen(port, () => console.log(`🚀 Servidor MCP corriendo en puerto ${port}`));
