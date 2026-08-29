import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_DATABASE = { rooms: [] };

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeHashEquals(candidate, expectedHash) {
  const actual = Buffer.from(hashToken(candidate), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class RoomStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.database = structuredClone(EMPTY_DATABASE);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.database = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
  }

  async persist() {
    const snapshot = JSON.stringify(this.database, null, 2);
    const temporaryPath = `${this.filePath}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(temporaryPath, snapshot, 'utf8');
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  activeRoomByCode(code) {
    return this.database.rooms.find((room) => room.code === code && room.active);
  }

  participantByToken(token) {
    if (!token) return null;
    for (const room of this.database.rooms) {
      const participant = room.participants.find((item) => safeHashEquals(token, item.tokenHash));
      if (participant) return { room, participant };
    }
    return null;
  }

  publicRoom(room, participantId) {
    return {
      id: room.id,
      code: room.code,
      active: room.active,
      content: room.content,
      version: room.version,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      participantId,
      participantCount: room.participants.length,
      peerConnected: room.participants.some(
        (participant) => participant.id !== participantId && participant.foreground,
      ),
    };
  }

  async createRoom() {
    let code;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while (this.activeRoomByCode(code));

    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const participant = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      pushToken: null,
      foreground: false,
      joinedAt: now,
    };
    const room = {
      id: randomUUID(),
      code,
      active: true,
      content: '',
      version: 0,
      createdAt: now,
      updatedAt: now,
      participants: [participant],
    };
    this.database.rooms.push(room);
    await this.persist();
    return { room: this.publicRoom(room, participant.id), token };
  }

  async joinRoom(rawCode) {
    const code = String(rawCode ?? '').replace(/\D/g, '');
    const room = this.activeRoomByCode(code);
    if (!room) throw Object.assign(new Error('Room code was not found.'), { status: 404 });
    if (room.participants.length >= 2) {
      throw Object.assign(new Error('This room already has two people.'), { status: 409 });
    }

    const token = randomBytes(32).toString('base64url');
    const participant = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      pushToken: null,
      foreground: false,
      joinedAt: new Date().toISOString(),
    };
    room.participants.push(participant);
    room.updatedAt = new Date().toISOString();
    await this.persist();
    return { room: this.publicRoom(room, participant.id), token };
  }

  requireParticipant(token, { allowInactive = false } = {}) {
    const result = this.participantByToken(token);
    if (!result || (!allowInactive && !result.room.active)) {
      throw Object.assign(new Error('Your session is no longer active.'), { status: 401 });
    }
    return result;
  }

  async updateContent(token, content) {
    const { room, participant } = this.requireParticipant(token);
    if (typeof content !== 'string' || content.length > 4000) {
      throw Object.assign(new Error('Text must contain at most 4,000 characters.'), { status: 400 });
    }
    room.content = content;
    room.version += 1;
    room.updatedAt = new Date().toISOString();
    await this.persist();
    return { room, participant, publicRoom: this.publicRoom(room, participant.id) };
  }

  async setPushToken(token, pushToken) {
    const { participant } = this.requireParticipant(token);
    participant.pushToken = typeof pushToken === 'string' ? pushToken : null;
    await this.persist();
  }

  async setForeground(token, foreground) {
    const result = this.participantByToken(token);
    if (!result || !result.room.active) return;
    result.participant.foreground = Boolean(foreground);
    await this.persist();
  }

  async logout(token) {
    const { room } = this.requireParticipant(token);
    room.active = false;
    room.updatedAt = new Date().toISOString();
    for (const participant of room.participants) participant.foreground = false;
    await this.persist();
    return room;
  }
}

export function bearerToken(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}
