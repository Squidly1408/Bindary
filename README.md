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

## Deploying to Firebase Hosting

This project is also configured to deploy to Firebase Hosting at:

`https://bindary-books.web.app`

`firebase.json` points hosting at `dist/` and `.firebaserc` targets the `bindary-books`
project, so no extra setup is needed beyond having the Firebase CLI installed and being
logged into an account with access to that project.

1. Install the CLI if you don't already have it:

   ```bash
   npm install -g firebase-tools
   ```

2. Log in once:

   ```bash
   firebase login
   ```

3. Build and deploy:

   ```bash
   npm run build
   firebase deploy --only hosting
   ```

   Firestore rules deploy separately with `firebase deploy --only firestore`.

## Ads (Google AdSense)

Bindary can show a single AdSense ad bar at the bottom of the app. It's off by default —
see [documentation/adsense-setup.md](documentation/adsense-setup.md) for how to get an
AdSense account, wire up the required env vars, and the policy notes around how the ad
refresh is (and isn't) compliant.

## Google Search Console & Google Ads tag

`index.html` also carries two other Google integrations, both site-wide and unrelated to
AdSense:

- A `google-site-verification` meta tag plus [public/googlec4dc011b74e61d45.html](public/googlec4dc011b74e61d45.html),
  used to verify site ownership in Google Search Console.
- A Google Ads conversion tag (`gtag.js`, `AW-18399927744`) in `<head>`, used to track
  conversions for Google Ads campaigns. Unlike the AdSense script, this one only reports
  data — it doesn't render anything — so it's loaded unconditionally on every screen,
  including login/loading.

If either ID ever needs to change, update it directly in `index.html`.

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