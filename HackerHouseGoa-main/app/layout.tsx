import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";

import { COLORS, EVENT } from "@/lib/brand";

import "./globals.css";

/**
 * Root layout — server component on purpose. Nothing here needs the browser, and
 * keeping it on the server means `metadata` / `viewport` are statically known.
 */

/**
 * Absolute base for every relative URL in metadata. Without it Next warns and
 * emits relative og:image URLs, which X and WhatsApp both refuse to unfurl.
 * The literal fallback keeps the build green on a machine with no env file.
 *
 * `??` on its own is NOT enough, and the failure is severe. It only substitutes
 * for an *unset* variable, so a declared-but-empty `NEXT_PUBLIC_SITE_URL=` —
 * which is exactly how .env.example writes every optional var, and what a
 * cleared Vercel dashboard field produces — flows straight into `new URL("")`,
 * which throws. This is module scope in the ROOT layout, so that TypeError is
 * not a bad unfurl: it fails `next build` outright for every route
 * ("Failed to collect page data for /_not-found", ERR_INVALID_URL). A value
 * missing its scheme ("frameingoa.vercel.app") throws identically. So validate,
 * matching how `siteUrl()` in lib/share.ts already treats a blank value.
 */
/**
 * NEVER hardcode a real third-party hostname here. An earlier version defaulted
 * to a specific `*.vercel.app` name that turned out to belong to somebody else's
 * project — which would have pointed our og:image and canonical URL at a
 * stranger's site on any deploy that forgot to set NEXT_PUBLIC_SITE_URL.
 *
 * Vercel injects VERCEL_PROJECT_PRODUCTION_URL (hostname only, no scheme)
 * automatically, so the correct production URL is derivable with zero config on
 * the platform we deploy to. Localhost is the last resort and is, at worst,
 * obviously wrong rather than quietly pointing somewhere real.
 */
const LOCAL_FALLBACK = "http://localhost:3000";

function resolveSiteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured);
    } catch {
      /* Malformed — fall through rather than crash the build. */
    }
  }
  // Vercel gives this as a bare hostname, e.g. "frameingoa-app.vercel.app".
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelHost) {
    try {
      return new URL(`https://${vercelHost.replace(/^https?:\/\//, "")}`);
    } catch {
      /* fall through */
    }
  }
  return new URL(LOCAL_FALLBACK);
}

const SITE_URL = resolveSiteUrl();

const TITLE = "FrameInGoa — HH Goa 2026 Frame Generator";
const DESCRIPTION =
  "Upload one photo and instantly get a branded Hacker House Goa profile-picture frame " +
  "and a Builder ID card badge. No login, nothing uploaded until you choose to share — " +
  "every graphic is drawn in your browser.";

export const metadata: Metadata = {
  metadataBase: SITE_URL,
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "FrameInGoa",
  keywords: ["Hacker House Goa", "HH Goa 2026", "profile picture frame", "builder id", EVENT.hashtag],
  openGraph: {
    type: "website",
    url: "/",
    siteName: "FrameInGoa",
    title: TITLE,
    description: DESCRIPTION,
    // No explicit `images` entry: app/opengraph-image.tsx is a file-convention
    // route, so Next injects it here automatically at the right size. Listing a
    // second image by hand would make X pick whichever it saw first.
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: COLORS.green,
  width: "device-width",
  initialScale: 1,
  // The page paints edge-to-edge green; "cover" lets it run under the iPhone
  // notch and home indicator. Every fixed bar then pads itself back out with
  // env(safe-area-inset-*).
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
