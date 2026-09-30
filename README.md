# Top 10 Lounge – site + orders backend

Needs Node 22.13 or newer. One dependency (express). The database is one file, `data.db`.

    npm install
    cp .env.example .env      # set ADMIN_PASSWORD and the lounge coordinates
    npm start

- Site: http://localhost:3000
- Admin: http://localhost:3000/admin (sign in with ADMIN_PASSWORD)

## How it works
- Customers place orders on the site. The server re-checks every item and price from its own product table and saves the order with status `placed`. Each line keeps the price at the time of the order, so editing prices later never changes old orders.
- Statuses: placed, confirmed, preparing, out_for_delivery, delivered, cancelled. Every change is logged in `order_events`. Pickup orders skip out_for_delivery.
- Admin (/admin): live order list (refreshes every 10 s, beeps on a new order), one-tap status buttons, map link and distance, ID-check flag on alcohol orders, and a Products tab to change prices or mark items sold out. The site picks up new prices and sold-out items on the next page load.
- If the site can't reach the backend, checkout falls back to the old WhatsApp message.
- The first run copies `products.json` into the database. After that the database is the source of truth. To change items, edit them in the Products tab.

## WhatsApp alert (optional)
Fill WA_TOKEN, WA_PHONE_ID and WA_TO. WhatsApp only delivers free-text messages to numbers that messaged your business number in the last 24 hours. For a reliable alert to the lounge, create an approved message template and I can switch the alert to it. Until then the admin page's sound and the server log are the alerts.

## Going live
Put it behind HTTPS (Caddy is the easiest) so the admin password isn't sent in the clear, back up `data.db` regularly, and keep ADMIN_PASSWORD long.

## Customer order tracking
- After checkout the customer can tap "Track my order". A yellow banner under the header follows them around the site while the order is active, and "Track order" / "Track my order" links open a lookup by order number + phone number (the phone must match, so nobody else can see rider details).
- The tracker refreshes every 8 seconds. When the status changes the customer gets a sound, a vibration on phones, a pop-up message and a flashing tab title.
- Time estimates are set when the order is placed: drinks only 25 min, cooked food 40, choma 55 (pickup 10 less). In /admin, "+10 min" pushes an order's time out; orders past their time show a red "Late" tag. Change the numbers in `etaMinutes()` in server.js.
- Marking an order "out for delivery" in /admin asks for the rider's name and phone. The customer then sees the name and a "Call rider" button.
- Set LOUNGE_PHONE near the top of the script in public/index.html so cancelled orders show a number to call.
- These alerts only reach customers while the site is open in their browser. SMS or WhatsApp is the next step for people who have left the page.

## Admin command center (/admin)
Sidebar + top bar layout. Dashboard (today's sales, orders, pending, late), Orders (search, date/status/type/alcohol/late filters, click a row for the full order drawer with timeline, rider, +10 min, cancel, print receipt), Menu & Products (search, category and availability filters, price edit, sold-out switch), Customers, and Reports (sales, top products, revenue by category, average delivery time) all come from your real orders. Reports and customers use the latest 300 orders (the orders API takes `?limit=` up to 2000). Room bookings, taxi, rider applications and job applications are placeholders until they are saved in the backend.

## Installable app (PWA)
The customer site (/) can be installed to the phone's home screen and opens full screen like an app.
- Files: `public/manifest.webmanifest`, `public/sw.js` (service worker), `public/offline.html`, `public/icons/`. The head tags, the "Install app" header button and the registration script are in `public/index.html`.
- **It needs HTTPS** (localhost is fine for testing). Service workers and installing do not work over plain http on a real domain.
- Android/Chrome: an "Install app" button appears in the header (or use the browser menu). iPhone/Safari: the same button shows a hint, then Share > Add to Home Screen.
- Caching: the site page is fetched from the network first (so price and page changes show up) and the last copy is used when offline. `/api/*` (menu, orders, tracking) and `/admin` are never cached. Orders always need a connection.
- After changing the icons or the caching rules in `sw.js`, bump `VERSION` at the top of `sw.js` so phones drop the old cache.
- To change the icons, replace the PNGs in `public/icons/` (same names and sizes; the "maskable" ones need the logo inside the middle 80%).

## Product photos
- Photos are files in `public/img/`, one per product, named by product ID (`p1.webp` = Tusker Lager). `image-map.csv` lists every ID, product name and the original file it came from.
- They are WebP, flattened on white, at the original photo's size (up to 600 px), 3 to 49 KB each. They load lazily as people scroll, and the service worker keeps every photo a customer has seen so the menu still shows pictures offline.
- **To replace a photo:** export a new WebP (square or portrait, white background, ideally 600 px or larger on the long side), save it over `public/img/<id>.webp`, then change `IMG_V` near the top of the script in `public/index.html` (for example "1" to "2"). Without that bump, phones keep the old picture for up to a week.
- **To add a product:** add it in `products.json` and the `D` list in `public/index.html` with `"i":"/img/<id>.webp"`, and drop the photo in `public/img/`.
