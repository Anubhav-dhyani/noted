import { createServer } from 'node:http';
import { createApplication } from './app.js';
import { MongoRoomStore } from './store.js';

const port = Number(process.env.PORT ?? 4000);
const store = new MongoRoomStore(process.env.MONGODB_URI, process.env.MONGODB_DB ?? 'noted');
await store.init();

const { app, attachSockets } = createApplication({
  store,
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? '',
});
const server = createServer(app);
attachSockets(server);

server.listen(port, '0.0.0.0', () => {
  console.log(`Noted server listening on http://0.0.0.0:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
