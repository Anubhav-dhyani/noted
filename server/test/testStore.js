import { randomBytes, randomInt, randomUUID } from 'node:crypto';

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

export class TestRoomStore {
  constructor() {
    this.rooms = [];
  }

  async init() {}
  async health() {}

  async publicRoom(room, participantId) {
    const messages = room.messages.map((message) => {
      let status;
      if (message.authorId === participantId) {
        status = message.seenBy.some((id) => id !== participantId)
          ? 'seen'
          : message.deliveredTo.some((id) => id !== participantId) ? 'delivered' : 'sent';
      }
      return { ...message, ...(status ? { status } : {}) };
    });
    return {
      id: room.id,
      name: room.name,
      code: room.code,
      active: room.active,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      participantId,
      participantCount: room.participants.length,
      peerConnected: room.participants.some((item) => item.id !== participantId && item.foreground),
      messages,
      unreadCount: room.messages.filter(
        (message) => message.authorId !== participantId && !message.seenBy.includes(participantId),
      ).length,
    };
  }

  async createRoom(rawName) {
    if (rawName === undefined) rawName = 'Private session';
    const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw httpError('Enter a name for the session.', 400);
    if (name.length > 50) throw httpError('Session names must contain at most 50 characters.', 400);
    const token = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const participant = { id: randomUUID(), token, pushToken: null, foreground: false };
    const room = {
      id: randomUUID(), name, code: String(randomInt(1_000_000)).padStart(6, '0'), active: true,
      createdAt: now, updatedAt: now, participants: [participant], messages: [],
    };
    this.rooms.push(room);
    return { room: await this.publicRoom(room, participant.id), token };
  }

  async joinRoom(code) {
    const room = this.rooms.find((item) => item.code === code && item.active);
    if (!room) throw httpError('Room code was not found.', 404);
    if (room.participants.length >= 2) throw httpError('This room already has two people.', 409);
    const token = randomBytes(16).toString('hex');
    const participant = { id: randomUUID(), token, pushToken: null, foreground: false };
    room.participants.push(participant);
    room.updatedAt = new Date().toISOString();
    return { room: await this.publicRoom(room, participant.id), token };
  }

  async requireParticipant(token) {
    for (const room of this.rooms) {
      const participant = room.participants.find((item) => item.token === token);
      if (participant && room.active) return { room, participant };
    }
    throw httpError('Your session is no longer active.', 401);
  }

  async sendMessage(token, rawText, replyToId, clientId) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw httpError('Write a message before sending.', 400);
    if (text.length > 4000) throw httpError('Messages must contain at most 4,000 characters.', 400);
    const { room, participant } = await this.requireParticipant(token);
    const existing = clientId ? room.messages.find(
      (message) => message.authorId === participant.id && message.clientId === clientId,
    ) : null;
    if (existing) return { room, participant, message: { ...existing, status: 'sent' } };
    const original = replyToId ? room.messages.find((item) => item.id === replyToId) : null;
    if (replyToId && !original) throw httpError('The message you replied to is no longer available.', 400);
    const message = {
      id: randomUUID(), text, authorId: participant.id, createdAt: new Date().toISOString(),
      deliveredTo: [], seenBy: [],
      ...(original ? { replyTo: { id: original.id, text: original.text.slice(0, 280), authorId: original.authorId } } : {}),
      ...(typeof clientId === 'string' ? { clientId } : {}),
    };
    room.messages.push(message);
    room.updatedAt = message.createdAt;
    return { room, participant, message: { ...message, status: 'sent' } };
  }

  async markDelivered(token, messageId) {
    const { room, participant } = await this.requireParticipant(token);
    const pending = room.messages.filter((message) => (
      message.authorId !== participant.id
      && (!messageId || message.id === messageId)
      && !message.deliveredTo.includes(participant.id)
    ));
    pending.forEach((message) => message.deliveredTo.push(participant.id));
    return { room, participant, messageIds: pending.map((message) => message.id) };
  }

  async markSeen(token) {
    const { room, participant } = await this.requireParticipant(token);
    const pending = room.messages.filter(
      (message) => message.authorId !== participant.id && !message.seenBy.includes(participant.id),
    );
    pending.forEach((message) => {
      if (!message.deliveredTo.includes(participant.id)) message.deliveredTo.push(participant.id);
      message.seenBy.push(participant.id);
    });
    return { room, participant, messageIds: pending.map((message) => message.id) };
  }

  async setPushToken(token, pushToken) {
    const { participant } = await this.requireParticipant(token);
    participant.pushToken = pushToken;
  }

  async setForeground(token, foreground) {
    try {
      const { participant } = await this.requireParticipant(token);
      participant.foreground = Boolean(foreground);
    } catch {}
  }

  async logout(token) {
    const { room } = await this.requireParticipant(token);
    room.active = false;
    room.participants.forEach((item) => { item.foreground = false; });
    return room;
  }
}
