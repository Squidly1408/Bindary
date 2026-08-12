# Bindary

Bindary turns completed tasks into poems and stores them in a private, Firebase-backed library.

## Requirements

- Node.js 20.x or newer
- A Firebase project with Authentication and Firestore enabled

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file in the project root.

3. Copy the values from `.env.example` and fill in your Firebase project settings:

   ```bash
   VITE_FIREBASE_API_KEY=
   VITE_FIREBASE_AUTH_DOMAIN=
   VITE_FIREBASE_PROJECT_ID=
   VITE_FIREBASE_STORAGE_BUCKET=
   VITE_FIREBASE_MESSAGING_SENDER_ID=
   VITE_FIREBASE_APP_ID=
   ```

4. In Firebase Console, enable:

   - Authentication with Email/Password sign-in
   - Cloud Firestore

5. Make sure Firestore rules allow each signed-in user to read and write their own data.

   A matching rules file is included in `firestore.rules`. Deploy it to your Firebase project before using the app.
   If you use the Firebase CLI, the included `firebase.json` is already wired to that rules file.

    Example rules:

    ```
    rules_version = '2';
    service cloud.firestore {
       match /databases/{database}/documents {
          function isSignedIn() {
             return request.auth != null;
          }

          function isOwner(userId) {
             return isSignedIn() && request.auth.uid == userId;
          }

          match /users/{userId} {
             allow read, write: if isOwner(userId);

             match /books/{bookId} {
                allow read, create, update, delete: if isOwner(userId);
             }

             match /tasks/{taskId} {
                allow read, create, update, delete: if isOwner(userId);
             }
          }
       }
    }
    ```

## Run locally

Start the Vite dev server:

```bash
npm run dev
```

If the default port is already in use, Vite will choose another one automatically.

## Build for upload

Create a production build:

```bash
npm run build
```

The built app is written to `dist/`.

## Deploying to GitHub Pages

This project is configured for:

`https://squidly1408.github.io/pages/Bindary/`

The Vite base path is already set for that location in `vite.config.js`.

When deploying:

1. Run `npm run build`.
2. Upload the contents of `dist/` to the GitHub Pages target.
3. Keep the site published at `/pages/Bindary/` so the asset paths stay correct.

## Data storage

When a user signs in, Bindary stores data in Firestore under:

- `users/{uid}/books`
- `users/{uid}/tasks`

Auth persistence is enabled, so previously signed-in users should be restored on reload.

## Notes

- The app uses a single React entry point in `poem-library.jsx`.
- The favicon, app icon, and social preview image are in `public/`.
- If Firebase env vars are missing, the app shows a setup screen instead of the login UI.
- If you see `Missing or insufficient permissions`, the Firestore rules have not been deployed or the user is not signed in to the same Firebase project.