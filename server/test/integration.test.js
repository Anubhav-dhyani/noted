import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { io as createClient } from 'socket.io-client';
import { createApplication } from '../src/app.js';
import { TestRoomStore } from './testStore.js';

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 3000);
    socket.once(event, (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

test('two clients create, join, send a message, and close the room', async (context) => {
  const store = new TestRoomStore();
  await store.init();
  const { app, attachSockets } = createApplication({ store });
  const server = createServer(app);
  attachSockets(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const creator = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' }).then((response) => response.json());
  const joiner = await fetch(`${baseUrl}/api/rooms/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: creator.room.code }),
  }).then((response) => response.json());

  const first = createClient(baseUrl, { auth: { token: creator.token } });
  const second = createClient(baseUrl, { auth: { token: joiner.token } });
  context.after(() => { first.disconnect(); second.disconnect(); });
  await Promise.all([once(first, 'connect'), once(second, 'connect')]);

  const receivedUpdate = once(second, 'message:new');
  const acknowledgement = new Promise((resolve) => {
    first.emit('message:send', { text: 'sent only after pressing send' }, resolve);
  });
  assert.equal((await acknowledgement).ok, true);
  assert.equal((await receivedUpdate).text, 'sent only after pressing send');

  const closed = once(second, 'session:closed');
  first.emit('session:logout', {}, () => undefined);
  await closed;
  await assert.rejects(() => store.requireParticipant(joiner.token), /no longer active/);
});
