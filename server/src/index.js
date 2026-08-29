import { createServer } from 'node:http';
import { createApplication } from './app.js';
import { RoomStore } from './store.js';

const port = Number(process.env.PORT ?? 4000);
const dataFile = process.env.DATA_FILE ?? './data/noted.json';
const store = new RoomStore(dataFile);
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
