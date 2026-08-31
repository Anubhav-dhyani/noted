import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoRoomStore } from '../src/store.js';

const uri = process.env.MONGODB_TEST_URI;

test('MongoDB persists rooms, sessions, and message history', { skip: !uri }, async () => {
  const databaseName = `noted_test_${randomUUID().replaceAll('-', '')}`;
  const store = new MongoRoomStore(uri, databaseName);
  await store.init();
  try {
    const creator = await store.createRoom('Mongo Room');
    const joiner = await store.joinRoom(creator.room.code);
    const sent = await store.sendMessage(creator.token, 'persisted in MongoDB');
    assert.equal(sent.message.text, 'persisted in MongoDB');

    const restored = await store.requireParticipant(joiner.token);
    const publicRoom = await store.publicRoom(restored.room, restored.participant.id);
    assert.equal(publicRoom.messages[0].text, 'persisted in MongoDB');

    await store.sendMessage(joiner.token, 'persistent reply', sent.message.id);
    const roomWithReply = await store.publicRoom(restored.room, restored.participant.id);
    assert.deepEqual(roomWithReply.messages[1].replyTo, {
      id: sent.message.id,
      text: sent.message.text,
      authorId: sent.message.authorId,
    });

    await store.logout(joiner.token);
    await assert.rejects(() => store.requireParticipant(creator.token), /no longer active/);
  } finally {
    await store.database.dropDatabase();
    await store.close();
  }
});
