import 'dotenv/config';
import './setup-proxy.js';
import { app } from './app.js';

const PORT = 3001;
app.listen({ port: PORT, host: '0.0.0.0' }, (err: Error | null) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server running at http://localhost:${PORT}`);
});
