const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export function isExpoPushToken(value) {
  return typeof value === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(value);
}

export async function pushRoomUpdate({ recipients, roomCode, content, accessToken }) {
  const tokens = recipients.map((participant) => participant.pushToken).filter(isExpoPushToken);
  if (tokens.length === 0) return [];

  const preview = content.trim() || 'The shared note was cleared.';
  const messages = tokens.flatMap((to) => [
    {
      to,
      title: `Room ${roomCode}`,
      body: preview.slice(0, 180),
      sound: 'default',
      priority: 'high',
      channelId: 'messages',
      data: { kind: 'room-open', roomCode },
    },
    {
      to,
      priority: 'high',
      _contentAvailable: true,
      data: { kind: 'room-overlay', roomCode, text: preview.slice(0, 500) },
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
