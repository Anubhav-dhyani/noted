import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const MESSAGE_LIMIT = 100;
const REPLY_PREVIEW_LIMIT = 280;

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function messageStatus(message, participantId) {
  if (message.authorId !== participantId) return undefined;
  const seenBy = message.seenBy ?? [];
  const deliveredTo = message.deliveredTo ?? [];
  if (seenBy.some((id) => id !== participantId)) return 'seen';
  if (deliveredTo.some((id) => id !== participantId)) return 'delivered';
  return 'sent';
}

function publicMessage(message, participantId) {
  const status = messageStatus(message, participantId);
  return {
    id: message._id,
    text: message.text,
    authorId: message.authorId,
    createdAt: iso(message.createdAt),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.clientId ? { clientId: message.clientId } : {}),
    ...(status ? { status } : {}),
  };
}

function sessionName(value) {
  if (value === undefined) return 'Private session';
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw httpError('Enter a name for the session.', 400);
  if (name.length > 50) throw httpError('Session names must contain at most 50 characters.', 400);
  return name;
}

export class MongoRoomStore {
  constructor(uri, databaseName = 'noted') {
    if (!uri) throw new Error('MONGODB_URI is required.');
    this.client = new MongoClient(uri);
    this.databaseName = databaseName;
  }

  async init() {
    await this.client.connect();
    this.database = this.client.db(this.databaseName);
    this.rooms = this.database.collection('rooms');
    this.messages = this.database.collection('messages');
    await Promise.all([
      this.rooms.createIndex({ code: 1 }, { unique: true }),
      this.rooms.createIndex({ 'participants.tokenHash': 1 }),
      this.messages.createIndex({ roomId: 1, createdAt: -1 }),
      this.messages.createIndex(
        { roomId: 1, authorId: 1, clientId: 1 },
        { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
      ),
    ]);
    await this.rooms.updateMany(
      { active: true },
      { $set: { 'participants.$[].foreground': false } },
    );
  }

  async close() {
    await this.client.close();
  }

  async health() {
    await this.database.command({ ping: 1 });
  }

  async messagesForRoom(roomId, participantId) {
    const messages = await this.messages
      .find({ roomId })
      .sort({ createdAt: -1 })
      .limit(MESSAGE_LIMIT)
      .toArray();
    return messages.reverse().map((message) => publicMessage(message, participantId));
  }

  async publicRoom(room, participantId) {
    return {
      id: room._id,
      name: room.name ?? 'Private session',
      code: room.code,
      active: room.active,
      createdAt: iso(room.createdAt),
      updatedAt: iso(room.updatedAt),
      participantId,
      participantCount: room.participants.length,
      peerConnected: room.participants.some(
        (participant) => participant.id !== participantId && participant.foreground,
      ),
      messages: await this.messagesForRoom(room._id, participantId),
      unreadCount: await this.messages.countDocuments({
        roomId: room._id,
        authorId: { $ne: participantId },
        seenBy: { $ne: participantId },
      }),
    };
  }

  async createRoom(rawName) {
    const name = sessionName(rawName);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = randomBytes(32).toString('base64url');
      const now = new Date();
      const participant = {
        id: randomUUID(),
        tokenHash: hashToken(token),
        pushToken: null,
        foreground: false,
        joinedAt: now,
      };
      const room = {
        _id: randomUUID(),
        name,
        code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        active: true,
        createdAt: now,
        updatedAt: now,
        participants: [participant],
      };
      try {
        await this.rooms.insertOne(room);
        return { room: await this.publicRoom(room, participant.id), token };
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
    throw new Error('Could not allocate a unique room code.');
  }

  async joinRoom(rawCode) {
    const code = String(rawCode ?? '').replace(/\D/g, '');
    if (code.length !== 6) throw httpError('Enter a valid 6-digit room code.', 400);

    const token = randomBytes(32).toString('base64url');
    const participant = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      pushToken: null,
      foreground: false,
      joinedAt: new Date(),
    };
    const result = await this.rooms.findOneAndUpdate(
      { code, active: true, 'participants.1': { $exists: false } },
      { $push: { participants: participant }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      const existing = await this.rooms.findOne({ code, active: true });
      if (existing) throw httpError('This room already has two people.', 409);
      throw httpError('Room code was not found.', 404);
    }
    return { room: await this.publicRoom(result, participant.id), token };
  }

  async requireParticipant(token) {
    if (!token) throw httpError('Your session is no longer active.', 401);
    const tokenHash = hashToken(token);
    const room = await this.rooms.findOne({ active: true, 'participants.tokenHash': tokenHash });
    if (!room) throw httpError('Your session is no longer active.', 401);
    const participant = room.participants.find((item) => item.tokenHash === tokenHash);
    return { room, participant, tokenHash };
  }

  async sendMessage(token, rawText, rawReplyToId, rawClientId) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw httpError('Write a message before sending.', 400);
    if (text.length > 4000) throw httpError('Messages must contain at most 4,000 characters.', 400);

    const { room, participant } = await this.requireParticipant(token);
    const clientId = typeof rawClientId === 'string' && rawClientId.length <= 100 ? rawClientId : undefined;
    if (clientId) {
      const existing = await this.messages.findOne({
        roomId: room._id,
        authorId: participant.id,
        clientId,
      });
      if (existing) return { room, participant, message: publicMessage(existing, participant.id) };
    }
    let replyTo;
    if (rawReplyToId !== undefined && rawReplyToId !== null && rawReplyToId !== '') {
      if (typeof rawReplyToId !== 'string') throw httpError('The replied message is invalid.', 400);
      const original = await this.messages.findOne({ _id: rawReplyToId, roomId: room._id });
      if (!original) throw httpError('The message you replied to is no longer available.', 400);
      replyTo = {
        id: original._id,
        text: original.text.slice(0, REPLY_PREVIEW_LIMIT),
        authorId: original.authorId,
      };
    }
    const now = new Date();
    const message = {
      _id: randomUUID(), roomId: room._id, authorId: participant.id, text, createdAt: now,
      deliveredTo: [], seenBy: [],
      ...(replyTo ? { replyTo } : {}),
      ...(clientId ? { clientId } : {}),
    };
    const updated = await this.rooms.updateOne(
      { _id: room._id, active: true },
      { $set: { updatedAt: now } },
    );
    if (!updated.matchedCount) throw httpError('Your session is no longer active.', 401);
    try {
      await this.messages.insertOne(message);
    } catch (error) {
      if (error?.code !== 11000 || !clientId) throw error;
      const existing = await this.messages.findOne({ roomId: room._id, authorId: participant.id, clientId });
      if (!existing) throw error;
      return { room: { ...room, updatedAt: now }, participant, message: publicMessage(existing, participant.id) };
    }
    return {
      room: { ...room, updatedAt: now },
      participant,
      message: publicMessage(message, participant.id),
    };
  }

  async markDelivered(token, messageId) {
    const { room, participant } = await this.requireParticipant(token);
    const query = {
      roomId: room._id,
      authorId: { $ne: participant.id },
      deliveredTo: { $ne: participant.id },
      ...(messageId ? { _id: messageId } : {}),
    };
    const pending = await this.messages.find(query, { projection: { _id: 1 } }).toArray();
    if (pending.length) {
      await this.messages.updateMany(
        { _id: { $in: pending.map((message) => message._id) } },
        { $addToSet: { deliveredTo: participant.id } },
      );
    }
    return { room, participant, messageIds: pending.map((message) => message._id) };
  }

  async markSeen(token) {
    const { room, participant } = await this.requireParticipant(token);
    const query = {
      roomId: room._id,
      authorId: { $ne: participant.id },
      seenBy: { $ne: participant.id },
    };
    const pending = await this.messages.find(query, { projection: { _id: 1 } }).toArray();
    if (pending.length) {
      await this.messages.updateMany(
        { _id: { $in: pending.map((message) => message._id) } },
        {
          $addToSet: {
            deliveredTo: participant.id,
            seenBy: participant.id,
          },
        },
      );
    }
    return { room, participant, messageIds: pending.map((message) => message._id) };
  }

  async setPushToken(token, pushToken) {
    const { room, participant, tokenHash } = await this.requireParticipant(token);
    const value = typeof pushToken === 'string' ? pushToken : null;
    await this.rooms.updateOne(
      { _id: room._id, 'participants.tokenHash': tokenHash },
      { $set: { 'participants.$.pushToken': value } },
    );
    participant.pushToken = value;
  }

  async setForeground(token, foreground) {
    if (!token) return;
    const tokenHash = hashToken(token);
    await this.rooms.updateOne(
      { active: true, 'participants.tokenHash': tokenHash },
      { $set: { 'participants.$.foreground': Boolean(foreground) } },
    );
  }

  async logout(token) {
    const { room } = await this.requireParticipant(token);
    const updatedAt = new Date();
    const result = await this.rooms.findOneAndUpdate(
      { _id: room._id, active: true },
      { $set: { active: false, updatedAt, 'participants.$[].foreground': false } },
      { returnDocument: 'after' },
    );
    if (!result) throw httpError('Your session is no longer active.', 401);
    return result;
  }
}

export function bearerToken(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}
