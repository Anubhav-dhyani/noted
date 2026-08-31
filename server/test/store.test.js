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
  const creator = await store.createRoom('Best Friends');
  assert.equal(creator.room.name, 'Best Friends');
  assert.match(creator.room.code, /^\d{6}$/);
  assert.equal(creator.room.participantCount, 1);

  const joiner = await store.joinRoom(creator.room.code);
  assert.equal(joiner.room.participantCount, 2);
  await assert.rejects(() => store.requireParticipant('wrong-token'), /no longer active/);

  const sent = await store.sendMessage(creator.token, 'hello from creator');
  assert.equal(sent.message.text, 'hello from creator');
  assert.equal(sent.message.status, 'sent');
  const restored = await store.requireParticipant(joiner.token);
  assert.equal(restored.room.messages[0].text, 'hello from creator');

  const reply = await store.sendMessage(joiner.token, 'hello back', sent.message.id);
  assert.deepEqual(reply.message.replyTo, {
    id: sent.message.id,
    text: 'hello from creator',
    authorId: sent.message.authorId,
  });
  const delivered = await store.markDelivered(joiner.token, sent.message.id);
  assert.deepEqual(delivered.messageIds, [sent.message.id]);
  const creatorSession = await store.requireParticipant(creator.token);
  let creatorView = await store.publicRoom(creatorSession.room, creatorSession.participant.id);
  assert.equal(creatorView.messages[0].status, 'delivered');
  assert.equal((await store.publicRoom(restored.room, restored.participant.id)).unreadCount, 1);
  await store.markSeen(joiner.token);
  creatorView = await store.publicRoom(creatorSession.room, creatorSession.participant.id);
  assert.equal(creatorView.messages[0].status, 'seen');
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
  await assert.rejects(() => store.createRoom('   '), /name for the session/);
  const creator = await store.createRoom('Limits');
  await assert.rejects(() => store.sendMessage(creator.token, '   '), /before sending/);
  await assert.rejects(() => store.sendMessage(creator.token, 'x'.repeat(4001)), /4,000/);
});

test('retries with the same client id without duplicating a message', async () => {
  const store = await testStore();
  const creator = await store.createRoom('Reliable');
  const first = await store.sendMessage(creator.token, 'only once', undefined, 'client-1');
  const retry = await store.sendMessage(creator.token, 'only once', undefined, 'client-1');
  assert.equal(retry.message.id, first.message.id);
  const restored = await store.requireParticipant(creator.token);
  assert.equal(restored.room.messages.length, 1);
});
