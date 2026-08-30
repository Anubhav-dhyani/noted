import assert from 'node:assert/strict';
import test from 'node:test';
import { TestRoomStore } from './testStore.js';

async function testStore() {
  const store = new TestRoomStore();
  await store.init();
  return store;
}

test('creates, joins, restores, sends messages, and closes a room', async () => {
  const store = await testStore();
  const creator = await store.createRoom();
  assert.match(creator.room.code, /^\d{6}$/);
  assert.equal(creator.room.participantCount, 1);

  const joiner = await store.joinRoom(creator.room.code);
  assert.equal(joiner.room.participantCount, 2);
  await assert.rejects(() => store.requireParticipant('wrong-token'), /no longer active/);

  const sent = await store.sendMessage(creator.token, 'hello from creator');
  assert.equal(sent.message.text, 'hello from creator');
  const restored = await store.requireParticipant(joiner.token);
  assert.equal(restored.room.messages[0].text, 'hello from creator');

  const reply = await store.sendMessage(joiner.token, 'hello back', sent.message.id);
  assert.deepEqual(reply.message.replyTo, {
    id: sent.message.id,
    text: 'hello from creator',
    authorId: sent.message.authorId,
  });
  await assert.rejects(
    () => store.sendMessage(joiner.token, 'bad reply', 'missing-message'),
    /no longer available/,
  );

  await assert.rejects(() => store.joinRoom(creator.room.code), /already has two people/);
  await store.logout(joiner.token);
  await assert.rejects(() => store.requireParticipant(creator.token), /no longer active/);
});

test('rejects empty and oversized messages', async () => {
  const store = await testStore();
  const creator = await store.createRoom();
  await assert.rejects(() => store.sendMessage(creator.token, '   '), /before sending/);
  await assert.rejects(() => store.sendMessage(creator.token, 'x'.repeat(4001)), /4,000/);
});
