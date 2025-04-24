const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
require('dotenv').config({ path: 'env.txt' });

const app = express();
const port = process.env.PORT || 3001;

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("Conectado a MongoDB"))
.catch(err => console.error("Error de conexión a MongoDB:", err));

// Inicializar cliente OCR desde variable de entorno
let client;
try {
  const credentials = JSON.parse(process.env.OCR_CREDENTIALS_JSON);
  client = new vision.ImageAnnotatorClient({ credentials });
  console.log("Cliente OCR inicializado correctamente");
} catch (err) {
  console.error("Error al inicializar OCR:", err.message);
}

app.use(express.json({ limit: '10mb' }));

// Ruta principal
app.get('/', (req, res) => {
  res.send('Nebula Backend funcionando correctamente');
});

// Endpoint OCR
app.post('/ocr', async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) {
      return res.status(400).json({ success: false, error: "Falta el campo base64" });
    }

    const [result] = await client.textDetection({ image: { content: base64 } });
    const detections = result.textAnnotations;
    const texto = detections.length ? detections[0].description : "No se detectó texto";

    res.json({ success: true, text: texto.trim() });
  } catch (error) {
    console.error("Error en OCR:", error);
    res.status(500).json({ success: false, error: "OCR falló", details: error.message });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log("Servidor corriendo en http://localhost:" + port);
});
