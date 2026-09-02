# MedCheck Admin — Setup

Plain HTML/CSS/JS, no build step. Talks directly to your existing Firebase project (`medcheckdata`) using the Firebase Web SDK, loaded from a CDN — nothing to `npm install`.

## 1. Register a Web app in Firebase Console

Your Android app's `google-services.json` config **will not work here** — it's a different SDK config shape. You need a separate Web app registration in the same project:

1. Firebase Console → gear icon → **Project settings** → **General** tab
2. Scroll to "Your apps" → click the **`</>`** (Web) icon
3. Name it something like `MedCheck Admin` → **Register app**
4. Copy the `firebaseConfig` object it shows you
5. Paste those exact values into `js/firebase-init.js`, replacing the `PASTE_YOUR_...` placeholders

## 2. Create your first admin account

There's no self-registration for admins on purpose — only you should be able to create one.

1. Firebase Console → **Authentication** → **Users** tab → **Add user**
2. Enter an email + password for yourself (this becomes your admin login)
3. Copy the **User UID** it generates
4. Firebase Console → **Realtime Database** → go to the root of your database
5. Manually add: `admins/<paste-the-uid-here> = true` (boolean `true`, not the string `"true"`)

Repeat step 1–5 for each additional admin/panelist account you want to grant access to.

## 3. Add the security rules

**Don't skip this.** Right now nothing in your database rules stops a doctor from writing `verificationStatus: "Verified"` to their own record directly. See the message alongside this file for the exact rule snippet to merge into your existing `database.rules.json` — I need to see your current rules first before giving you the final version, so this repo doesn't include a rules file yet.

## 4. One small addition needed in the mobile app

Doctor registration currently doesn't store a submission timestamp, so this dashboard can't sort "oldest pending first." Add one field to the profile object in `DoctorRegisterPage.xaml.cs` (in the `profile` object built during `OnRegisterClicked`, alongside the other fields):

```csharp
var profile = new
{
    firstName,
    middleName,
    lastName,
    name = fullName,
    email,
    phone = fullPhone,
    role = "doctor",
    licenseNumber = license,
    specialization = specializationString,
    registeredAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()   // ← add this line
};
```

Existing doctor accounts registered before this change will just show "Date unknown" and sort to the top — harmless, not worth backfilling manually.

## 5. Run it locally to test

No server needed — any static file server works, e.g. with Python already on most machines:

```bash
cd medcheck-admin
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

## 6. Deploy to Firebase Hosting

```bash
npm install -g firebase-tools     # one-time, if you don't have it
firebase login
cd medcheck-admin
firebase deploy --only hosting
```

It'll give you a live URL like `https://medcheckdata.web.app` when done.

## What this does NOT do yet

- **Doesn't notify the doctor** when approved/rejected. Your `FcmNotificationService.cs` already has a working pattern (`SendFcmMessageAsync`) for pushing a notification to one user by UID — wiring that in is a small follow-up once this is confirmed working, not included here to keep this batch of changes reviewable on its own.
- **Doesn't gate doctor features by verification status** in the mobile app yet (blocking posting availability / accepting new patient links until Verified) — that's a separate change to the Doctor-side pages in MauiApp1, not this website.
