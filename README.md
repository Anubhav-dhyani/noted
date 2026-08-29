# Noted Together

An Android-first two-person shared-text app. One person creates a permanent six-digit room,
the other joins it, and both phones see edits in real time. The room remains valid across app
and phone restarts until either participant logs out. When the receiving app is backgrounded,
the backend sends a heads-up push notification and a data-only push that can display the text
over the currently used Android app (after the user grants the overlay permission).

## Project layout

- `mobile/` — Expo SDK 57 / React Native application and the local Kotlin overlay module.
- `server/` — Node.js, Express, Socket.IO, persistent room storage, and Expo push delivery.

## 1. Run the backend

Node.js 22.13 or newer is required by Expo SDK 57.

```bash
cd server
npm install
npm test
npm run dev
```

The server listens on port `4000`. Room data is atomically persisted to
`server/data/noted.json`. For production, mount the `/app/data` directory as a persistent
volume when using the included Dockerfile.

Environment variables:

- `PORT` — defaults to `4000`.
- `DATA_FILE` — defaults to `./data/noted.json`.
- `CORS_ORIGIN` — comma-separated allowed origins; defaults to `*` for native apps.
- `EXPO_ACCESS_TOKEN` — optional when Expo push access security is enabled.

The public server must use HTTPS in the installed app. Railway, Render, Fly.io, or any Docker
host with a persistent disk can run this server.

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

Expo Go can test the screens, create/join flow, and foreground real-time sync. Android remote
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

- Rooms allow exactly two participants and never expire automatically.
- A logout closes the room for both participants and invalidates its code.
- Session tokens are held in Android Keystore/iOS Keychain through Expo SecureStore; only token
  hashes are persisted by the backend.
- Text is limited to 4,000 characters and sent after a 350 ms typing debounce.
- Android ultimately controls background execution. The visible push remains the reliable
  fallback when Doze mode delays the data-only task or the overlay permission is disabled.
- A floating overlay is Android-only. iOS receives normal push notifications instead.
