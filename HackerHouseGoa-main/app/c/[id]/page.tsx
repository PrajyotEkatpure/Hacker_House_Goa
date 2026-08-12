import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BRAND_ASSETS, EVENT, OG } from "@/lib/brand";

/**
 * Share landing page: the URL that goes into the X post.
 *
 * Its entire job is the unfurl. X fetches this page, reads og:image and renders
 * the card in the timeline — so a missing or relative image here means a blank
 * thumbnail, which is the single most visible way this feature can fail.
 */

// Nothing here is cacheable per-build: the id only exists after a user uploads.
export const dynamic = "force-dynamic";

/** Matches the ids /api/cards mints — also a cheap guard against path traversal. */
const ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

/** Localhost, never a real third-party host — see the note in app/layout.tsx. */
const LOCAL_FALLBACK = "http://localhost:3000";

/**
 * `??` only substitutes for an *unset* variable. A declared-but-empty
 * `NEXT_PUBLIC_SITE_URL=` (how .env.example writes every optional var) survives
 * it as "", and a value with no scheme survives it verbatim — either one turns
 * the absolute og:image below into a RELATIVE one, which is precisely the blank
 * -thumbnail failure this whole page exists to prevent. Validate instead.
 */
function resolveSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).toString().replace(/\/+$/, "");
    } catch {
      /* Malformed — fall through. */
    }
  }
  // Injected by Vercel as a bare hostname, so production is correct unconfigured.
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelHost) {
    try {
      return new URL(`https://${vercelHost.replace(/^https?:\/\//, "")}`)
        .toString()
        .replace(/\/+$/, "");
    } catch {
      /* fall through */
    }
  }
  return LOCAL_FALLBACK;
}

const SITE_URL = resolveSiteUrl();

/**
 * Public base of the Vercel Blob store, e.g.
 * https://xxxx.public.blob.vercel-storage.com — there is no way to derive it, so
 * it has to come from the environment. When it is absent (local dev, or a deploy
 * with no Blob store linked) we fall back to the site's own OG image so the
 * unfurl still shows branded artwork instead of nothing.
 */
const BLOB_BASE = process.env.NEXT_PUBLIC_BLOB_BASE_URL?.trim().replace(/\/+$/, "");

interface CardUrls {
  /** Absolute URL for og:image — always set, always absolute. */
  og: string;
  /** Absolute URL of the full-size graphic, or null when blob storage is off. */
  main: string | null;
}

function cardUrls(id: string): CardUrls {
  // The empty id is real: generateMetadata passes "" when the path segment fails
  // ID_PATTERN. Without this guard that built `${BLOB_BASE}/cards//og.png`, a
  // guaranteed 404 — i.e. the blank thumbnail — instead of the branded fallback.
  if (!BLOB_BASE || id.length === 0) {
    // The root opengraph-image.tsx route: branded, always present, never blank.
    return { og: `${SITE_URL}/opengraph-image`, main: null };
  }
  return {
    og: `${BLOB_BASE}/cards/${id}/og.png`,
    main: `${BLOB_BASE}/cards/${id}/main.png`,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  // Next 15: dynamic route params arrive as a Promise.
  const { id } = await params;
  const safeId = ID_PATTERN.test(id) ? id : "";
  const { og } = cardUrls(safeId);

  const title = `A Builder ID from ${EVENT.wordmark}`;
  const description = `${EVENT.tagline}. Make your own ${EVENT.hashtag} frame and Builder ID card in one tap.`;

  return {
    title,
    description,
    alternates: { canonical: safeId ? `/c/${safeId}` : "/" },
    openGraph: {
      type: "website",
      siteName: "FrameInGoa",
      title,
      description,
      url: safeId ? `${SITE_URL}/c/${safeId}` : SITE_URL,
      images: [{ url: og, width: OG.width, height: OG.height, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [og],
    },
  };
}

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID_PATTERN.test(id)) notFound();

  const { main } = cardUrls(id);

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-4 pb-10">
      <header className="relative mt-4 overflow-hidden rounded-md border-[3px] border-goa-red bg-goa-green-deep p-3">
        <img
          src={BRAND_ASSETS.sun}
          alt=""
          aria-hidden="true"
          width={64}
          height={64}
          className="pointer-events-none absolute -top-3 -right-2 h-16 w-16 opacity-25"
        />
        <div className="relative flex items-center gap-3">
          <img
            src={BRAND_ASSETS.logo}
            alt={EVENT.wordmark}
            width={240}
            height={64}
            className="h-9 w-auto shrink-0"
          />
          <div className="min-w-0">
            <p className="font-data text-[9px] uppercase tracking-[0.24em] text-goa-yellow">{EVENT.studio}</p>
            <p className="font-display text-2xl leading-none text-goa-cream">FrameInGoa</p>
          </div>
        </div>
      </header>

      <h1 className="mt-5 font-display text-3xl leading-tight text-goa-cream">
        Someone just shipped their Builder ID.
      </h1>
      <p className="mt-1 font-data text-[11px] uppercase tracking-[0.2em] text-goa-yellow">
        {EVENT.datesShort} · {EVENT.cohort}
      </p>

      <div className="mt-4 w-full">
        {main ? (
          // Plain <img>: the graphic lives on Blob storage, next/image is disabled
          // project-wide, and the exact pixels matter more than a loader here.
          <img
            src={main}
            alt="A Hacker House Goa Builder ID card"
            className="w-full rounded-md border-[3px] border-goa-cream bg-goa-green-deep object-contain"
          />
        ) : (
          <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 rounded-md border-[3px] border-dashed border-goa-cream/45 bg-goa-green-deep p-6 text-center">
            <span aria-hidden="true" className="text-3xl">
              🌴
            </span>
            <p className="font-data text-[11px] uppercase tracking-[0.2em] text-goa-cream/70">
              Image storage is off for this deploy
            </p>
            <p className="font-data text-[11px] leading-snug text-goa-cream/55">
              The graphic lives in the post it was shared with. Make your own below.
            </p>
          </div>
        )}
      </div>

      <Link
        href="/"
        className="mt-5 flex min-h-[56px] w-full items-center justify-center rounded-sm border-[3px] border-goa-ink bg-goa-yellow px-4 font-display text-xl tracking-wide text-goa-ink shadow-[4px_4px_0_0_var(--color-goa-ink)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_0_var(--color-goa-ink)]"
      >
        Make yours →
      </Link>

      <div
        aria-hidden="true"
        className="my-5 h-4 w-full opacity-50"
        style={{
          backgroundImage: `url(${BRAND_ASSETS.wave})`,
          backgroundRepeat: "repeat-x",
          backgroundSize: "auto 100%",
        }}
      />

      <footer className="pb-2">
        <p className="font-display text-lg text-goa-cream">{EVENT.wordmark}</p>
        <p className="mt-1 font-data text-[10px] uppercase tracking-[0.2em] text-goa-cream/55">
          {EVENT.dates} · {EVENT.motto}
        </p>
        <p className="mt-2 font-data text-sm tracking-[0.12em] text-goa-yellow">{EVENT.hashtag}</p>
      </footer>
    </main>
  );
}
