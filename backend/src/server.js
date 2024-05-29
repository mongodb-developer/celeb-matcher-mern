const express = require('express');
const bodyParser = require('body-parser');
const MongoClient = require('mongodb').MongoClient;
const AWS = require('aws-sdk');
const { Base64 } = require('js-base64');
const Jimp = require('jimp');
const { promisify } = require('util');

const MONGODB_URI = process.env.MONGODB_URI;
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY;
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
const DEBUG = process.env.DEBUG ? ['1', 'true', 'on', 'yes'].includes(process.env.DEBUG.trim().toLowerCase()) : false;

const app = express();
app.use(bodyParser.json());

const bedrock = new AWS.BedrockRuntime({
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_KEY,
  region: 'us-east-1',
});

let db;
let celebImagesCollection;

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db();
  celebImagesCollection = db.collection('celeb_images');
  
  const pong = await db.command({ ping: 1 });
  if (pong.ok !== 1) {
    throw new Error('Cluster connection is not okay!');
  }
  console.log('Connected to MongoDB');
}

app.post('/api/search', async (req, res) => {
  const { img } = req.body;

  if (!img) {
    return res.status(400).send('Please upload an image first.');
  }

  const imageBase64 = img.split(",")[1];
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  const image = await Jimp.read(imageBuffer);
  image.resize(800, 600).quality(85);

  const imgBuffer = await promisify(image.getBuffer).call(image, Jimp.MIME_JPEG);
  const imgBase64 = imgBuffer.toString('base64');

  const body = constructBody(imgBase64);
  const embedding = await getEmbedding(body);

  const docs = await celebImagesCollection.aggregate([
    {
      $vectorSearch: {
        index: 'vector_index',
        path: 'embeddings',
        queryVector: embedding,
        numCandidates: 15,
        limit: 3,
      }
    },
    { $project: { image: 1 } }
  ]).toArray();

  const images = docs.map(doc => standardizeImage(doc.image));
  const description = await generateImageDescription(images, imgBase64);

  res.json({
    description,
    images,
  });
});

function constructBody(base64String, text = null) {
  const body = {
    inputImage: base64String,
    embeddingConfig: { outputEmbeddingLength: 1024 }
  };
  if (text) {
    body.inputText = text;
  }
  return JSON.stringify(body);
}

async function getEmbedding(body) {
  const params = {
    body,
    modelId: 'amazon.titan-embed-image-v1',
    accept: 'application/json',
    contentType: 'application/json'
  };

  const response = await bedrock.invokeModel(params).promise();
  return JSON.parse(response.body).embedding;
}

async function generateImageDescription(imagesBase64Strs, imageBase64) {
  const claudeBody = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    system: 'Please act as face comparison analyzer.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: imageBase64,
            },
          },
          ...imagesBase64Strs.map(data => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data,
            },
          })),
          {
            type: 'text',
            text: 'Please let the user know how their first image is similar to the other 3 and which one is the most similar?',
          }
        ],
      }
    ],
  });

  const params = {
    body: claudeBody,
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    accept: 'application/json',
    contentType: 'application/json'
  };

  const response = await bedrock.invokeModel(params).promise();
  return JSON.parse(response.body).content[0].text || 'No description available';
}

function standardizeImage(imageBase64) {
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const img = Jimp.read(imageBuffer);
  const imgBuffer = img.getBuffer(Jimp.MIME_JPEG);
  return imgBuffer.toString('base64');
}

const PORT = process.env.PORT || 3001;

connectToDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to connect to database', err);
    process.exit(1);
  });
