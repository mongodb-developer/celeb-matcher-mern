import express from 'express';
import bodyParser from 'body-parser';
import { MongoClient } from 'mongodb';
import AWS from 'aws-sdk';
import Jimp from 'jimp';
import cors from 'cors';
import { promisify } from 'util';
import { Buffer } from 'buffer';
import dotenv from 'dotenv';

dotenv.config();

AWS.config.suppressMaintenanceModeMessage = true;

const { MONGODB_URI, AWS_ACCESS_KEY, AWS_SECRET_KEY } = process.env;

const app = express();
app.use(bodyParser.json());
app.use(cors());

const bedrock = new AWS.BedrockRuntime({
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_KEY,
  region: 'us-east-1',
});

let db;
let celebImagesCollection;

const connectToDatabase = async () => {
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

const constructBody = (base64String, text = null) => {
  const body = {
    inputImage: base64String,
    embeddingConfig: { outputEmbeddingLength: 1024 }
  };

  if (text) {
    body.inputText = text;
  }

  return JSON.stringify(body);
};

app.post('/api/search', async (req, res) => {
  const { img } = req.body;

  if (!img) {
    return res.status(400).send('Please upload an image first.');
  }

  const imageBase64 = img.split(",")[1];

  if (!isValidBase64(imageBase64)) {
    return res.status(400).send('Invalid image format.');
  }

  try {
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

    const images = docs.map(doc => doc.image);
    const description = await generateImageDescription(images, imgBase64);

    res.json({
      description,
      images,
    });
    console.log("Data sent:", { description });
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).send('Internal Server Error');
  }
});

const getEmbedding = async (body) => {
  const params = {
    body,
    modelId: 'amazon.titan-embed-image-v1',
    accept: 'application/json',
    contentType: 'application/json'
  };

  const response = await bedrock.invokeModel(params).promise();
  return JSON.parse(response.body).embedding;
}

const generateImageDescription = async (images_base64_strs, image_base64) => {
  const claudeBody = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    system: 'Please act as face comparison analyzer.',
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": "image/jpeg",
              "data": image_base64,
            },
          },
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": "image/jpeg",
              "data": images_base64_strs[0],
            },
          },
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": "image/jpeg",
              "data": images_base64_strs[1],
            },
          },
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": "image/jpeg",
              "data": images_base64_strs[2],
            },
          },
          {
            "type": "text",
            "text": "Please let the user know how their first image is similar to the other 3 and which one is the most similar?",
          },
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

  try {
    console.log('Sending request to AWS with body');
    const response = await bedrock.invokeModel(params).promise();
    return JSON.parse(response.body).content[0].text || 'No description available';
  } catch (error) {
    console.error('Error from AWS:', error);
    throw error;
  }
}

const isValidBase64 = (base64) => {
  const base64Regex = /^([0-9a-zA-Z+/=]{4})*(([0-9a-zA-Z+/=]{4})|([0-9a-zA-Z+/=]{3}=)|([0-9a-zA-Z+/=]{2}==))?$/;
  return base64Regex.test(base64);
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