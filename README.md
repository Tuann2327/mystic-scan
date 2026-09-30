# Mystic Scan

A mobile web app for the packing table. It keeps the camera on and scans a UPS or USPS label when you tap **Scan label**. Then it shows the Shopify order the label belongs to:

- order number and customer name
- shipping address
- line items with image, variant, SKU and quantity. Quantities above 1 are highlighted.

A button opens the order in the **Shopify app**. If you tick **Auto-open Shopify after scan**, the app opens by itself. The checkbox setting is saved on the phone.

## How it works

```
phone (public/index.html) ──POST /api/lookup──► server.js ──Admin GraphQL──► Shopify
```

- **Scanning:** Android Chrome uses the phone's built-in barcode reader. iPhone/Safari uses ZXing (WebAssembly), which the page loads by itself. The scanner reads full-resolution frames, which helps with the long USPS barcodes.
- **Barcode formats:**
  - UPS: the `1Z…` Code 128 barcode.
  - USPS: the IMpb barcode (`420` + ZIP + tracking number). The app removes the ZIP prefix.
  - The short "420 + ZIP" routing barcode on UPS labels is ignored.
- **Finding the order:** the server keeps a list of tracking numbers from orders updated in the last `LOOKBACK_DAYS` days (default 45). After the first load, it only fetches orders that changed since the last refresh. Most scans come back right away.
- **Access token:** your Shopify token stays on the server and never reaches the phone. Set `APP_PIN` so only your staff can look up customer data.

## 1. Connect to Shopify

In Shopify admin, go to **Settings → Apps → Develop apps**, or use the Shopify Dev Dashboard. Create an app for your own store with these Admin API scopes:

- `read_orders`
- `read_customers`
- `read_merchant_managed_fulfillment_orders`

Install the app on your store. If Shopify asks for **protected customer data** access (needed for name, address, email and phone), request it for your own store.

Copy `.env.example` to `.env` and fill it in:

- `SHOPIFY_STORE_DOMAIN` — e.g. `mystic-perfume.myshopify.com`
- Credentials, one of:
  - `SHOPIFY_ADMIN_TOKEN` (the `shpat_…` token), **or**
  - `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (Dev Dashboard app)
- `APP_PIN` — a PIN your team types once on each phone

## 2. Run it

Requires Node 20.12+. There are no packages to install.

```bash
npm start
```

## 3. Open it on the phone (HTTPS is required)

Phones only allow the camera on `https://` pages. Pick one option:

- **Quick test from your PC:** run a free Cloudflare tunnel and open the `https://…trycloudflare.com` link it prints on your phone:
  ```bash
  npx cloudflared tunnel --url http://localhost:3000
  ```
- **Permanent:** deploy this folder to any Node host, such as Render, Railway or Fly.io. Use `npm start` as the start command and add the `.env` values as environment variables.

On the phone, choose **Add to Home Screen** so the app opens full screen like a native app.

## Opening the Shopify app

The **Open in Shopify** link goes to `https://admin.shopify.com/store/<handle>/orders/<id>`.

- **Android:** the link is sent straight to the Shopify app (`com.shopify.mobile`). If the app isn't installed, the order opens in the browser.
- **iPhone:** `admin.shopify.com` links open the Shopify app when it's installed. Safari may sometimes open the web admin instead of the app when **auto-open** fires. If that happens, tap **Open in Shopify**. Once you've long-pressed the link and chosen "Open in Shopify", iOS usually remembers that choice.

If your admin URL uses a different store handle than your myshopify subdomain, set `SHOPIFY_STORE_HANDLE`.

## Troubleshooting

- **"No order found":**
  - The tracking number has to be on the order's fulfillment. This happens automatically when you buy the label in Shopify Shipping or a shipping app that syncs tracking.
  - Orders older than `LOOKBACK_DAYS` aren't indexed. Raise the value if you need older orders; orders older than 60 days also need the `read_all_orders` scope.
- **USPS barcode won't read:** hold the label flat and fill the frame with the barcode. Tap the ⚡ button to turn on the flashlight in dim light.
- **Camera is black:** make sure the page is `https://` and that the browser has camera permission.
