# Noted Together

An Android-first two-person private messaging app. People can create named sessions, join multiple
sessions using six-digit codes, switch between them, and see unread counts plus sent, delivered,
seen, and failed message states. Draft text stays local. Sessions remain valid across app, phone,
and backend restarts until a participant ends them. When a receiving session is not open, the backend sends a heads-up push notification
and a data-only push that can display the message
over the currently used Android app (after the user grants the overlay permission).

## Project layout

- `mobile/` — Expo SDK 57 / React Native application and the local Kotlin overlay module.
- `server/` — Node.js, Express, Socket.IO, MongoDB persistence, and Expo push delivery.

## 1. Run the backend

Node.js 22.13 or newer is required by Expo SDK 57.

```bash
cd server
npm install
cp .env.example .env
# Replace the placeholder MONGODB_URI in .env with your real connection string.
npm test
npm run dev
```

The server listens on port `4000`. Rooms, hashed session tokens, push tokens, and message history
are persisted in MongoDB. Create a MongoDB Atlas database (or another MongoDB deployment) and set
the connection string before starting the server.

Environment variables:

- `PORT` — defaults to `4000`.
- `MONGODB_URI` — required MongoDB connection string; keep it secret.
- `MONGODB_DB` — database name; defaults to `noted`.
- `CORS_ORIGIN` — comma-separated allowed origins; defaults to `*` for native apps.
- `EXPO_ACCESS_TOKEN` — optional when Expo push access security is enabled.

The public server must use HTTPS in the installed app. MongoDB is external, so a free Render web
service can restart or redeploy without losing rooms or messages. Add `MONGODB_URI` and
`MONGODB_DB=noted` to the Render service's Environment page before deploying.

## 2. Run the mobile app

Copy `mobile/.env.example` to `mobile/.env` and set the backend URL. A physical phone cannot
reach the computer through `localhost`; use the computer's LAN IP, for example:

```text
EXPO_PUBLIC_API_URL=http://192.168.1.10:4000
```

Then run:

```bash
cd mobile
npm install
npm start
```

Expo Go can test the screens, create/join flow, and foreground real-time messages. Android remote
push, headless notification tasks, and the native overlay are unavailable in Expo Go, so the
complete behavior requires the development build below.

## 3. Configure Expo push and build the development APK

```bash
cd mobile
npx eas-cli@latest login
npx eas-cli@latest init
```

`eas init` writes the EAS `projectId` used to request Expo push tokens. Configure Android FCM
credentials when EAS prompts you. Add the deployed HTTPS backend URL to each EAS environment
you intend to build, then build:

```bash
npx eas-cli@latest env:set --name EXPO_PUBLIC_API_URL --value https://YOUR-SERVER.example.com --environment production --visibility plaintext
```

```bash
npx eas-cli@latest build --platform android --profile development
```

Install the downloaded APK on both phones and start Metro with:

```bash
npx expo start --dev-client
```

Inside an active room, tap **Enable** and approve Android's **Display over other apps** setting.
Also allow notifications. Test by putting one phone in another app and editing text on the other.

## 4. Build your shareable production APK

Preview APK for direct installation:

```bash
npx eas-cli@latest build --platform android --profile preview
```

Production APK:

```bash
npx eas-cli@latest build --platform android --profile production
```

EAS build profiles are in `mobile/eas.json`. The production profile uses internal distribution
and creates an APK. The configuration stops a cloud build when its environment does not contain
`EXPO_PUBLIC_API_URL`, preventing an unusable APK. Change `buildType` to `app-bundle` later if
you want an AAB for Google Play.

## Behavior and platform notes

- Sessions have a required name in the current app, allow exactly two participants, and never expire automatically.
- The session inbox stores multiple secure membership tokens on the device and migrates the legacy single token automatically.
- Ending a session closes only that session for both participants and invalidates its code.
- Session tokens are held in Android Keystore/iOS Keychain through Expo SecureStore; only token
  hashes are persisted by the backend.
- Messages are limited to 4,000 characters and are sent only when the user taps **Send**.
- Message retries are idempotent, so retrying the same failed send does not create duplicates.
- The backend records delivery when the other client receives a message and records seen when that session is open.
- Push notifications include the session ID, so tapping one opens the correct session.
- MongoDB retains complete message history; session restoration returns the latest 100 messages.
- Android ultimately controls background execution. The visible push remains the reliable
  fallback when Doze mode delays the data-only task or the overlay permission is disabled.
- A floating overlay is Android-only. iOS receives normal push notifications instead.
