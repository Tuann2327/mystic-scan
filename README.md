# Mystic Scan

A mobile web app for the packing table. It keeps the camera on and scans a UPS or USPS label when you tap **Scan label**. Then it shows the Shopify order the label belongs to:

- order number and customer name
- shipping address
- line items with image, variant, SKU and quantity. Quantities above 1 are highlighted.

A button opens the order in the **Shopify app**. If you tick **Auto-open Shopify after scan**, the app opens by itself. The checkbox setting is saved on the phone.

## How it works

```
phone (public/index.html) ──POST /api/lookup──► Netlify Function / server.js ──Admin GraphQL──► Shopify
```

- **Scanning:** Android Chrome uses the phone's built-in barcode reader. iPhone/Safari uses ZXing (WebAssembly), which the page loads by itself. The scanner reads full-resolution frames, which helps with the long USPS barcodes.
- **Barcode formats:**
  - UPS: the `1Z…` Code 128 barcode.
  - USPS: the IMpb barcode (`420` + ZIP + tracking number). The app removes the ZIP prefix.
  - The short "420 + ZIP" routing barcode on UPS labels is ignored.
- **Finding the order:** Shopify's order search finds an order by its tracking number. Every result is double-checked against the order's actual tracking numbers before it's shown. A lookup takes about a second.
- **Access token:** your Shopify token stays on the server (or in Netlify's environment variables) and never reaches the phone. Set `APP_PIN` so only your staff can look up customer data.

| File | Role |
|---|---|
| `public/` | The phone app (static files) |
| `lib/shopify.js` | Shopify lookup, shared by both runtimes |
| `netlify/functions/` | `/api/lookup` and `/api/config` on Netlify |
| `server.js` | Local server, for running on your own PC |

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

Requires Node 20.12+. There are no packages to install. (Skip this step if you deploy to Netlify.)

```bash
npm start
```

## 3. Deploy to Netlify (recommended)

Netlify gives you an `https://` address, which phones require before they allow the camera.

1. **Netlify → Add new project → Import an existing project → GitHub →** pick `mystic-scan`.
2. The build settings come from `netlify.toml`, so leave the form as it is:
   - Build command: *(empty)*
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
3. **Site configuration → Environment variables →** add:

   | Key | Value |
   |---|---|
   | `SHOPIFY_STORE_DOMAIN` | `your-store.myshopify.com` |
   | `SHOPIFY_ADMIN_TOKEN` | your `shpat_…` token (mark it **secret**) |
   | `APP_PIN` | a PIN for staff. **Strongly recommended:** the Netlify address is public, and without a PIN anyone who finds it can look up customer names and addresses. |

   Optional: `SHOPIFY_STORE_HANDLE`, `SHOPIFY_API_VERSION`.
4. **Deploys → Trigger deploy.** Environment variables only take effect on a new deploy.
5. Open `https://<your-site>.netlify.app` on the phone, enter the PIN, and choose **Add to Home Screen**.

Every push to `main` redeploys automatically.

**Check it works:** `https://<your-site>.netlify.app/api/config` should show `{"pinRequired":true,"configured":true}`.

## Running locally instead

`npm start` serves the app on `http://localhost:3000`. Phones need HTTPS for the camera, so either:

- **Tunnel:** run `npx cloudflared tunnel --url http://localhost:3000` and open the printed `https://…trycloudflare.com` link; or
- **Self-signed certificate:** put `key.pem` and `cert.pem` in `certs/`. The server then also listens on `https://<PC-IP>:3443`, and the phone shows a one-time certificate warning. `certs/` is git-ignored.

## Opening the Shopify app

The **Open in Shopify** link goes to `https://admin.shopify.com/store/<handle>/orders/<id>`.

- **Android:** the link is sent straight to the Shopify app (`com.shopify.mobile`). If the app isn't installed, the order opens in the browser.
- **iPhone:** `admin.shopify.com` links open the Shopify app when it's installed. Safari may sometimes open the web admin instead of the app when **auto-open** fires. If that happens, tap **Open in Shopify**. Once you've long-pressed the link and chosen "Open in Shopify", iOS usually remembers that choice.

If your admin URL uses a different store handle than your myshopify subdomain, set `SHOPIFY_STORE_HANDLE`.

## Troubleshooting

- **"No order found":** the tracking number has to be on the order's fulfillment. This happens automatically when you buy the label in Shopify Shipping or a shipping app that syncs tracking.
- **"Server is not connected to Shopify":** the environment variables are missing. On Netlify, add them and redeploy.
- **USPS barcode won't read:** hold the label flat and fill the frame with the barcode. Tap the ⚡ button to turn on the flashlight in dim light.
- **Camera is black:** make sure the page is `https://` and that the browser has camera permission.
