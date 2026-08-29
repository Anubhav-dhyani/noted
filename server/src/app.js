import cors from 'cors';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { bearerToken } from './store.js';
import { isExpoPushToken, pushRoomUpdate } from './push.js';

function errorBody(error) {
  return { error: error instanceof Error ? error.message : 'Unexpected server error.' };
}

export function createApplication({ store, corsOrigin = '*', expoAccessToken = '' }) {
  const app = express();
  let io;
  app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_request, response) => response.json({ ok: true }));

  app.post('/api/rooms', async (_request, response, next) => {
    try {
      response.status(201).json(await store.createRoom());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/rooms/join', async (request, response, next) => {
    try {
      response.json(await store.joinRoom(request.body?.code));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/session', (request, response, next) => {
    try {
      const { room, participant } = store.requireParticipant(bearerToken(request));
      response.json({ room: store.publicRoom(room, participant.id) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/session/push-token', async (request, response, next) => {
    try {
      const pushToken = request.body?.pushToken ?? null;
      if (pushToken !== null && !isExpoPushToken(pushToken)) {
        return response.status(400).json({ error: 'The Expo push token is invalid.' });
      }
      await store.setPushToken(bearerToken(request), pushToken);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/session', async (request, response, next) => {
    try {
      const room = await store.logout(bearerToken(request));
      io?.to(room.id).emit('session:closed');
      io?.in(room.id).disconnectSockets(true);
      response.json({ roomId: room.id });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    response.status(error.status ?? 500).json(errorBody(error));
  });

  function attachSockets(httpServer) {
    io = new SocketServer(httpServer, {
      cors: { origin: corsOrigin === '*' ? true : corsOrigin.split(',') },
      maxHttpBufferSize: 32_000,
    });

    io.use((socket, next) => {
      try {
        const token = String(socket.handshake.auth?.token ?? '');
        const result = store.requireParticipant(token);
        socket.data.token = token;
        socket.data.participantId = result.participant.id;
        socket.data.roomId = result.room.id;
        next();
      } catch (error) {
        next(new Error('unauthorized'));
      }
    });

    io.on('connection', async (socket) => {
      socket.join(socket.data.roomId);
      const { room, participant } = store.requireParticipant(socket.data.token);
      socket.emit('room:state', store.publicRoom(room, participant.id));
      io.to(room.id).emit('room:presence', { participantCount: room.participants.length });

      socket.on('presence:set', async ({ foreground } = {}) => {
        await store.setForeground(socket.data.token, foreground);
      });

      socket.on('content:update', async ({ content } = {}, acknowledge = () => {}) => {
        try {
          const result = await store.updateContent(socket.data.token, content);
          io.to(result.room.id).emit('content:updated', {
            content: result.room.content,
            version: result.room.version,
            updatedAt: result.room.updatedAt,
            authorId: result.participant.id,
          });
          acknowledge({ ok: true, version: result.room.version });

          const recipients = result.room.participants.filter(
            (item) => item.id !== result.participant.id && !item.foreground,
          );
          pushRoomUpdate({
            recipients,
            roomCode: result.room.code,
            content: result.room.content,
            accessToken: expoAccessToken,
          }).catch((error) => console.error('Push delivery failed:', error.message));
        } catch (error) {
          acknowledge({ ok: false, error: error.message });
        }
      });

      socket.on('session:logout', async (_payload, acknowledge = () => {}) => {
        try {
          const closedRoom = await store.logout(socket.data.token);
          io.to(closedRoom.id).emit('session:closed');
          acknowledge({ ok: true });
          io.in(closedRoom.id).disconnectSockets(true);
        } catch (error) {
          acknowledge({ ok: false, error: error.message });
        }
      });

      socket.on('disconnect', () => store.setForeground(socket.data.token, false));
    });
    return io;
  }

  return { app, attachSockets };
}
