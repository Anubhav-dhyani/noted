import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoomStore } from '../src/store.js';

async function testStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noted-test-'));
  const store = new RoomStore(path.join(directory, 'rooms.json'));
  await store.init();
  return store;
}

test('creates, joins, restores, updates, and closes a persistent room', async () => {
  const store = await testStore();
  const creator = await store.createRoom();
  assert.match(creator.room.code, /^\d{6}$/);
  assert.equal(creator.room.participantCount, 1);

  const joiner = await store.joinRoom(creator.room.code);
  assert.equal(joiner.room.participantCount, 2);
  assert.throws(() => store.requireParticipant('wrong-token'), /no longer active/);

  const updated = await store.updateContent(creator.token, 'hello from creator');
  assert.equal(updated.room.version, 1);
  assert.equal(store.requireParticipant(joiner.token).room.content, 'hello from creator');

  await assert.rejects(() => store.joinRoom(creator.room.code), /already has two people/);
  await store.logout(joiner.token);
  assert.throws(() => store.requireParticipant(creator.token), /no longer active/);
});

test('rejects content above the supported limit', async () => {
  const store = await testStore();
  const creator = await store.createRoom();
  await assert.rejects(() => store.updateContent(creator.token, 'x'.repeat(4001)), /4,000/);
});
