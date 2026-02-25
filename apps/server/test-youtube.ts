import { YoutubeLoader } from './src/modules/knowledge/loaders/youtube.loader.js';

async function test() {
  process.env.RAPIDAPI_KEY = '5f9e6aad1fmsh72353abee33a106p1d98bajsn35d4e6992ffe';
  const loader = new YoutubeLoader();

  try {
    console.log('Testing YouTube Loader with Video Info...');
    const result = await loader.load('https://www.youtube.com/watch?v=arj7oStGLkU');
    console.log('Success!');
    console.log('Title:', result.title);
    console.log('Metadata:', result.metadata);
    console.log('Content preview (first 200 chars):');
    console.log(result.content.substring(0, 200) + '...');
  } catch (error) {
    console.error('Error:', error);
  }
}

test();
