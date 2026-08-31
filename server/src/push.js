const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export function isExpoPushToken(value) {
  return typeof value === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(value);
}

export async function pushRoomUpdate({ recipients, roomCode, roomId, roomName, text, replyText, accessToken }) {
  const tokens = recipients.map((participant) => participant.pushToken).filter(isExpoPushToken);
  if (tokens.length === 0) return [];

  const preview = text.trim();
  const replyPrefix = replyText ? `Replying to: ${replyText.trim().slice(0, 60)}\n` : '';
  const notificationBody = `${replyPrefix}${preview}`.slice(0, 180);
  const messages = tokens.flatMap((to) => [
    {
      to,
      title: roomName,
      body: notificationBody,
      sound: 'default',
      priority: 'high',
      channelId: 'messages',
      data: { kind: 'room-open', roomCode, roomId },
    },
    {
      to,
      priority: 'high',
      _contentAvailable: true,
      data: { kind: 'room-overlay', roomCode, roomId, text: `${roomName}: ${notificationBody}`.slice(0, 500) },
    },
  ]);

  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(messages),
  });
  if (!response.ok) throw new Error(`Expo push service returned ${response.status}.`);
  return response.json();
}
