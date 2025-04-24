
const express = require('express');
const mongoose = require('mongoose');
const vision = require('@google-cloud/vision');
require('dotenv').config({ path: 'env.txt' });

const app = express();
const port = process.env.PORT || 3001;

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("Conectado a MongoDB"))
.catch(err => console.error("Error de conexión a MongoDB:", err));

const client = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Nebula Backend FULL funcionando con OCR y MongoDB');
});

app.post('/ocr', async (req, res) => {
  try {
    const { base64 } = req.body;
    const [result] = await client.textDetection({ image: { content: base64 } });
    const detections = result.textAnnotations;
    res.json({ success: true, text: detections.length ? detections[0].description : "Nada detectado" });
  } catch (error) {
    console.error("Error en OCR:", error);
    res.status(500).json({ success: false, error: "OCR falló" });
  }
});

app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
