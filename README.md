# Conference Check-in

Registration with QR badges and attendance check-in by scanning QR codes.
All data is saved in a **JSON file on your drive** (`data.json`).

## Files

| File | What it is |
|---|---|
| `server.js` | Small local server. Serves the app and reads/writes `data.json`. No npm install needed. |
| `data.json` | **The database.** Registrations and check-ins. Created automatically if missing. |
| `data.backup.json` | A copy of `data.json`, made each time the server starts. |
| `index.html`, `app.js` | The app (Register / Scan / Attendees). |
| `core.js` | Data rules shared by the app and the server. |
| `cloud.js`, `firebase-config.js`, `firestore.rules` | Live shared database (Firebase) — optional, see below. |
| `lib/` | QR code generator (qrcode-generator), QR reader (jsQR), and CSV/Excel reader (SheetJS, loaded only when you import). |
| `start-windows.bat`, `start-mac-linux.sh` | Double-click to start the server. |

## Quick start (recommended)

1. Install **Node.js** (LTS) from nodejs.org.
2. Double-click `start-windows.bat` (Windows) or run `./start-mac-linux.sh` (Mac/Linux).
   You can also run `node server.js` in this folder.
3. Open **http://localhost:8080** on the same computer.
4. Phones and other laptops on the **same Wi-Fi** open the "Same Wi-Fi" address printed
   in the window, for example `http://192.168.1.20:8080`.

Every registration and check-in from every device is written to `data.json` at once.
The status line under the event name shows where data is being saved.
If the server stops, devices keep working and send their changes when it is back.

### Options

```
node server.js --data "D:\Events\Summit2026\data.json"   # use another file or location
node server.js --port 9000                                 # use another port
```

You may open `data.json` in any text editor. If you edit it while the server runs,
the server reloads it automatically. Keep the JSON valid.

## Live camera on phones (HTTPS)

Phone browsers allow the live camera only on **https://** addresses (or localhost).
Over plain `http://192.168...` you can still use **Scan photo**: it opens the phone
camera, you take a picture of the QR code, and it is read right away.

To turn on live scanning, create a certificate once in this folder:

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=checkin"
```

(On Windows, `openssl` comes with Git for Windows: run it in "Git Bash".)

Restart the server. It will also print `https://<your-ip>:8443`. Open that on the phone.
The phone warns that the certificate is not trusted, because you made it yourself.
Choose **Advanced, then Proceed**. Live scanning then works.

## Live shared database (Firebase) — recommended for many devices

With Firebase, every phone and computer shares **one live attendance list over the internet**.
You don't need a laptop server or a shared Wi-Fi, and the app can be hosted on GitHub Pages.

- **Live updates:** a scan on one phone appears on every other device within about a second.
- **Staff only:** staff sign in with an email and password. Only emails you list in the rules can read or write.
- **Offline-safe:** if the venue internet drops, each device keeps working and uploads its changes when it reconnects.
  Each device needs internet once, to sign in.
- **No double check-ins:** check-ins are protected, so if two devices scan the same badge at the same moment,
  one says "Welcome" and the other says "Already checked in".

### One-time setup (about 10 minutes)

1. **Create a project.** Go to https://console.firebase.google.com and sign in with your Google account.
   Click **Create a project** and name it, for example *nelc-2026*. Google Analytics is not needed.
2. **Turn on staff sign-in.**
   - Go to **Build → Authentication → Get started**, open the **Sign-in method** tab, and enable **Email/Password**.
   - Open the **Users** tab. Click **Add user** for each staff member or scanner device,
     for example `scanner1@yourdomain.com` with a password.
   - If you see **Settings → User actions → Enable create (sign-up)**, turn it **off** so nobody else can create accounts.
3. **Create the database.** Go to **Build → Firestore Database → Create database**.
   - Choose a location near you, such as **asia-southeast1 (Singapore)**.
   - Choose **production mode**.
4. **Lock it to your staff.** Open the **Rules** tab and replace everything with the contents of `firestore.rules`.
   Put your staff emails in the list, then click **Publish**.
5. **Connect the app.** Go to ⚙ **Project settings → General → Your apps** and click the **Web** icon `</>`.
   Register the app (Firebase Hosting is not needed) and copy the values from `firebaseConfig`
   into **`firebase-config.js`**: `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId` and `appId`.
6. **Open the app** in any of these ways. It shows a **Staff sign-in** screen; sign in once per device.
   - on GitHub Pages (see below);
   - from `server.js`;
   - from `index.html` directly.
7. **Move your existing data.** Click **Attendees → Restore / merge** and choose your old `data.json` or a backup file.
   Registrations and check-ins are uploaded.

The status line under the title shows **Live cloud database · your-email**. It shows *Offline…* or *Uploading changes…*
while the connection is down.

### Hosting on GitHub Pages

Upload these files to a GitHub repository:

- `index.html`, `app.js`, `core.js`, `cloud.js`, `firebase-config.js`
- the `lib` folder

Then turn on **Settings → Pages**. The included `.gitignore` keeps `data.json`, backups, certificates
and CSV/Excel files out of the repository. **Never upload attendee lists.**

The values in `firebase-config.js` are not passwords. They only name your project, so it is fine for them to be public.
The attendee data stays protected by sign-in and your rules.

GitHub Pages uses HTTPS, so the **live phone camera works with no extra setup**.

### Notes

- **Free plan:** the Spark plan includes 50,000 document reads, 20,000 writes and 1 GiB of storage per day.
  Opening the app reads the whole list once, about one read per attendee, then only the changes.
  For example, 500 attendees and 10 devices use a few thousand reads per day. Avoid constantly reloading the page.
- **Another event:** change `EVENT_ID` in `firebase-config.js` to start a new, empty list in the same project.
- **Back to the old modes:** set `apiKey` back to `"PASTE_API_KEY_HERE"`. The app then uses `data.json` or browser storage again.
- **Backups:** **Backup (JSON)** and **Export CSV** still work at any time. Make a backup after each session.

## Using a phone as the QR reader for the computer

The computer keeps the app open on the **Scan** tab and shows each result. The phone only reads the QR codes.
Pick one of these three methods.

### A. Phone as a Bluetooth scanner (Android, no Wi-Fi needed)

The phone pairs with the computer like a Bluetooth keyboard. Each QR it scans is "typed" into the app.

1. On an Android 9+ phone, install **Bluetooth QR & Barcode to PC**. It is free and open source,
   from F-Droid or https://github.com/fabi019/hid-barcode-scanner. Other "Bluetooth HID barcode scanner"
   apps work too.
2. In the app's settings:
   - Choose the **keyboard layout** that matches the computer (usually *US*).
   - Turn on sending **Enter** after each code.
3. Pair the phone with the computer: Windows **Settings → Bluetooth & devices → Add device**.
4. On the computer, open the app's **Scan** tab and choose **Bluetooth / USB scanner**. The box turns
   green with "Ready — scan a badge". If it says "Click here to activate", click it.
5. Scan badges with the phone. The result, beep and live list appear on the computer.

The app finds the attendee ID even if the keyboard layout garbles symbols or accented letters,
so names like *Niño* still check in correctly. The same mode works with any **USB or Bluetooth QR scanner gun**.

Notes:
- Keep the browser window **in front** while scanning, because keyboard input goes to the active window.
- If the phone app reports Bluetooth HID as not supported, your phone model can't do this. Use B or C instead.
- iPhones cannot act as a Bluetooth keyboard without extra hardware. Use B or C on iPhone.

### B. Phone as the computer's webcam

The phone appears as a camera on the computer. Choose it in the camera list on the Scan tab.

- **Windows 11 + Android 10 or newer:** go to **Settings → Bluetooth & devices → Mobile devices**, link the phone
  with the *Link to Windows* app, and turn on using it as a connected camera.
- **Mac + iPhone:** use Continuity Camera. The iPhone shows up as a camera automatically when it is nearby.
- **Any computer:** use webcam apps such as DroidCam or Iriun (Wi-Fi or USB).

Then on the computer, go to the **Scan** tab, click **Camera**, then **Start camera**, and pick the phone in the camera list.
The choice is remembered. Mount the phone on a stand pointing at where people show their badges.

### C. Phone scans over Wi-Fi with the server (any phone)

Open the server's address on the phone, for example `http://192.168.1.20:8080`, and scan there.
The live phone camera needs the HTTPS setup above; otherwise use **Scan photo**.
The computer's **Scan** tab shows a live **Latest check-ins** list, updated every ~1.5 seconds,
so it can serve as the display at the entrance.

## Without the server

Open `index.html` directly. In **desktop Chrome or Edge**, go to
**Attendees, then Data file**, and choose **Open JSON file…** or **Create new JSON file…**.
After that every change is saved to that file. Click **Reconnect** after reopening the browser.
Other browsers save to browser storage only. Use **Backup (JSON)** there.

## Two-day event with AM / PM sessions

Attendance is recorded per **session**. Each event day has an **AM** and a **PM** session.
The default is 2 days, so there are 4 sessions: Day 1 AM, Day 1 PM, Day 2 AM and Day 2 PM.

1. **Set up first:** go to **Attendees → Event days & sessions**. Enter the date of Day 1 and Day 2
   and the time PM starts (default 12:00), then click **Save event days**. You can use 1 to 5 days.
2. **Scan:** the **Session** box at the top of the Scan tab is on **Auto** by default. It picks the session
   from today's date and the time on that device, for example 8:30 on Day 1 = Day 1 AM and 1:05 = Day 1 PM.
   You can also pick a session by hand, for late entries or catch-up. Each device remembers its own choice.
3. A person checks in **once per session**. Scanning again in the same session shows
   "Already checked in". Scanning in a new session records that session.
4. **Attendees tab:**
   - Counters show how many people are present in each session. Click a counter to list who was present.
   - Each person has a chip per session (D1 AM, D1 PM …). A green chip means present. Click a chip to change it.
   - The filter also offers Absent per session, Attended all sessions, Missed a session and No attendance yet.
5. **Export CSV** has one column per session with the check-in time, plus *Sessions attended* and *Total sessions*.
   This makes certificates of full attendance easy to check.

**Reset check-ins** can clear one session or all of them.

Older data files with a single `checkedInAt` are converted automatically. That check-in goes to the
session matching its date and time, or to Day 1 AM.

## data.json format

```json
{
  "event": "National eLearning Conference 2026",
  "days": ["2026-12-01", "2026-12-02"],
  "cutoff": "12:00",
  "people": [
    {
      "id": "T66372",
      "name": "Juan Dela Cruz",
      "email": "juan@example.com",
      "org": "UP Diliman",
      "registeredAt": 1763342100000,
      "att": { "d1am": 1764549000000, "d1pm": 1764565500000, "d2am": null, "d2pm": null }
    }
  ]
}
```

`days` holds the date of each day. `cutoff` is when PM starts. `att` holds the check-in time for each session:
`d1am` is Day 1 AM, `d2pm` is Day 2 PM, and so on. Times are milliseconds since 1970, and `null` means absent.
**Export CSV** gives readable dates for Excel.

## Bulk upload (CSV or Excel)

On the **Register** tab, under **Bulk upload**, choose or drop a `.csv`, `.xlsx` or `.xls` file.
Click **Download template** to get a CSV with the right headings.

- **Recognised headings** (any capitalisation): **Name** / Full name / Participant, *or* **First name** + Middle name + **Last name** (+ Suffix);
  **Email** / E-mail address; **Organization** / Company / School / Institution / Affiliation / Agency.
  The heading row does not have to be the first row (a title above it is fine). Only the first sheet is read.
- A preview appears before anything is saved. Rows are **skipped** when the email is already registered
  (or repeated in the file), when the same name + organization already exists without an email, or when there is no name.
- Imported people are ticked in the **Attendees** list, ready to print their badges.

## Printing many badges

On the **Attendees** tab, tick people (the top checkbox selects everyone shown, so use Search and the
filter to narrow down first). Then click **Print QR badges**.

### A4 precut sticker sheet (14 per page)

- Each sticker is **2.9 in × 1.5 in**, laid out in 2 columns × 7 rows.
- **Badge 1 always goes on the top-left sticker.** After that it fills left to right, then top to bottom:
  1 2 / 3 4 / … / 13 14. A partly filled last sheet uses stickers from the top-left onwards.
- The sticker positions are set in inches. Measure your sticker paper:
  - **Top edge → 1st sticker:** default 0.60
  - **Left edge → 1st sticker:** default 1.13
  - **Gap between columns:** default 0.20
  - **Gap between rows:** default 0
  
  **Center on page** works out the margins from the gaps. The settings are remembered on each computer.
- **Print alignment test** prints 14 numbered outlines on plain A4 paper. Hold it over a sticker sheet
  against a window or light. If the boxes are off, change the numbers and test again before using sticker paper.
- In the browser's print dialog, choose paper **A4**, **Margins: None** and **Scale: 100%**,
  not "Fit to page", so the printout is not shrunk.
- Turn on **Draw sticker outlines** only when printing on plain paper that you will cut by hand.

### Single sticker

**Single sticker — 2.9 × 1.5 in** prints one badge per page, for label printers.

## Badge design

Each badge is **2.9 in long × 1.5 in wide**:

- **Top:** the name in large bold type across the full width. It uses one line when it fits, about 26 pt,
  and two smaller lines for long names.
- **Below:** the QR code on the left, with the organization and ID on the right.
  The conference name is not printed on the sticker.

**Download PNG** saves an 870 × 450 px image with 300 DPI stored inside, so it prints at exactly 2.9 × 1.5 in.
To use another sticker size, change `BADGE_IN_W` / `BADGE_IN_H` in `app.js`.

## QR content

`CONF1|{"i":"T66372","n":"Juan Dela Cruz","o":"UP Diliman"}`

The QR holds the ID and name. A badge made on any device can be scanned on any other device.
