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

  app.get('/', (_request, response) => response.json({ name: 'Noted API', ok: true }));

  app.get('/health', async (_request, response, next) => {
    try {
      await store.health?.();
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/rooms', async (_request, response, next) => {
    try {
      response.status(201).json(await store.createRoom(_request.body?.name));
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

  app.get('/api/session', async (request, response, next) => {
    try {
      const { room, participant } = await store.requireParticipant(bearerToken(request));
      response.json({ room: await store.publicRoom(room, participant.id) });
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
      const roomId = room._id ?? room.id;
      io?.to(roomId).emit('session:closed');
      io?.in(roomId).disconnectSockets(true);
      response.json({ roomId });
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
      const token = String(socket.handshake.auth?.token ?? '');
      store.requireParticipant(token).then((result) => {
        socket.data.token = token;
        socket.data.participantId = result.participant.id;
        socket.data.roomId = result.room._id ?? result.room.id;
        next();
      }).catch(() => next(new Error('unauthorized')));
    });

    io.on('connection', async (socket) => {
      socket.join(socket.data.roomId);
      const delivered = await store.markDelivered(socket.data.token);
      if (delivered.messageIds.length) {
        io.to(socket.data.roomId).emit('message:receipt', {
          messageIds: delivered.messageIds,
          status: 'delivered',
        });
      }
      const { room, participant } = await store.requireParticipant(socket.data.token);
      socket.emit('room:state', await store.publicRoom(room, participant.id));
      io.to(socket.data.roomId).emit('room:presence', { participantCount: room.participants.length });

      socket.on('presence:set', async ({ foreground } = {}) => {
        await store.setForeground(socket.data.token, foreground);
        if (foreground) {
          const seen = await store.markSeen(socket.data.token);
          if (seen.messageIds.length) {
            io.to(socket.data.roomId).emit('message:receipt', {
              messageIds: seen.messageIds,
              status: 'seen',
            });
          }
        }
      });

      socket.on('message:delivered', async ({ messageId } = {}) => {
        if (typeof messageId !== 'string') return;
        const deliveredResult = await store.markDelivered(socket.data.token, messageId);
        if (deliveredResult.messageIds.length) {
          io.to(socket.data.roomId).emit('message:receipt', {
            messageIds: deliveredResult.messageIds,
            status: 'delivered',
          });
        }
      });

      socket.on('messages:seen', async () => {
        const seen = await store.markSeen(socket.data.token);
        if (seen.messageIds.length) {
          io.to(socket.data.roomId).emit('message:receipt', {
            messageIds: seen.messageIds,
            status: 'seen',
          });
        }
      });

      socket.on('message:send', async ({ text, replyToId, clientId } = {}, acknowledge = () => {}) => {
        try {
          const result = await store.sendMessage(socket.data.token, text, replyToId, clientId);
          io.to(socket.data.roomId).emit('message:new', result.message);
          acknowledge({ ok: true, message: result.message });

          const recipients = result.room.participants.filter(
            (item) => item.id !== result.participant.id && !item.foreground,
          );
          pushRoomUpdate({
            recipients,
            roomCode: result.room.code,
            roomId: result.room._id ?? result.room.id,
            roomName: result.room.name ?? 'Private session',
            text: result.message.text,
            replyText: result.message.replyTo?.text,
            accessToken: expoAccessToken,
          }).catch((error) => console.error('Push delivery failed:', error.message));
        } catch (error) {
          acknowledge({ ok: false, error: error.message });
        }
      });

      socket.on('session:logout', async (_payload, acknowledge = () => {}) => {
        try {
          const closedRoom = await store.logout(socket.data.token);
          io.to(closedRoom._id ?? closedRoom.id).emit('session:closed');
          acknowledge({ ok: true });
          io.in(closedRoom._id ?? closedRoom.id).disconnectSockets(true);
        } catch (error) {
          acknowledge({ ok: false, error: error.message });
        }
      });

      socket.on('disconnect', () => {
        store.setForeground(socket.data.token, false).catch(() => undefined);
      });
    });
    return io;
  }

  return { app, attachSockets };
}
