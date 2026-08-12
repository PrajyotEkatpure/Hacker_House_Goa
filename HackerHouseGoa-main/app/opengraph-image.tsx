import fs from "node:fs";
import path from "node:path";

import { ImageResponse } from "next/og";

import { COLORS, EVENT, OG, TINTS } from "@/lib/brand";

/**
 * Static branded OG card for the root route (file convention → Next wires this
 * into <meta property="og:image"> automatically; layout.tsx deliberately lists
 * no explicit image so this one wins).
 *
 * Node runtime, not edge: we read the font files off disk with `fs`. Fetching
 * them from Google Fonts at build time — the usual ImageResponse example — would
 * make the build fail on a machine with no network, which is the exact failure
 * mode this project is built to avoid.
 *
 * These are the .woff files, NOT the .woff2 the browser gets from globals.css.
 * satori parses fonts with opentype.js, which understands ttf/otf/woff but
 * rejects woff2 outright ("Unsupported OpenType signature wOF2"). Both formats
 * therefore live in public/fonts: woff2 is what browsers download, woff is only
 * ever read server-side by this route.
 *
 * satori (the renderer behind ImageResponse) implements a *subset* of flexbox:
 * every element with more than one child needs an explicit `display: "flex"`,
 * `gap` is not reliable across versions, and there is no CSS cascade. Hence the
 * verbose inline styles and margin-based spacing below.
 */

export const runtime = "nodejs";
export const alt = "FrameInGoa — a Hacker House Goa 2026 profile frame and Builder ID card generator";
export const size = { width: OG.width, height: OG.height };
export const contentType = "image/png";

/**
 * Node hands back a Buffer that is a *view* into a shared, pooled ArrayBuffer,
 * so passing `buf.buffer` straight through would hand satori the whole pool and
 * it would fail to parse the font. Copy out an exact-length ArrayBuffer instead.
 */
function readFont(file: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(process.cwd(), "public/fonts", file));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Frond of the palm silhouette: a rounded bar rotated about its own centre. */
function frond(left: number, top: number, angle: number) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: 112,
        height: 20,
        borderRadius: 10,
        backgroundColor: TINTS.greenDeep,
        transform: `rotate(${angle}deg)`,
      }}
    />
  );
}

export default function OpengraphImage() {
  const rozha = readFont("rozha-one-latin-400-normal.woff");
  const yatra = readFont("yatra-one-devanagari-400-normal.woff");
  const grotesk400 = readFont("space-grotesk-latin-400-normal.woff");
  const grotesk700 = readFont("space-grotesk-latin-700-normal.woff");

  // The matchbox "strike strip" along the bottom edge — plain divs rather than a
  // repeating-linear-gradient, whose support in satori varies by version.
  const strikeDashes = Array.from({ length: 16 }, (_, i) => (
    <div
      key={i}
      style={{
        width: 40,
        height: 8,
        borderRadius: 4,
        marginRight: 20,
        backgroundColor: "rgba(255,243,220,0.35)",
      }}
    />
  ));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          backgroundColor: COLORS.green,
          fontFamily: "Space Grotesk",
        }}
      >
        {/* ---------------------------------------------------- sun + horizon */}
        <div
          style={{
            position: "absolute",
            left: 790,
            top: 170,
            width: 280,
            height: 140,
            backgroundColor: COLORS.yellow,
            borderTopLeftRadius: 140,
            borderTopRightRadius: 140,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 826,
            top: 132,
            width: 10,
            height: 46,
            borderRadius: 5,
            backgroundColor: COLORS.yellow,
            transform: "rotate(-30deg)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 925,
            top: 110,
            width: 10,
            height: 54,
            borderRadius: 5,
            backgroundColor: COLORS.yellow,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 1024,
            top: 132,
            width: 10,
            height: 46,
            borderRadius: 5,
            backgroundColor: COLORS.yellow,
            transform: "rotate(30deg)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 772,
            top: 318,
            width: 316,
            height: 8,
            borderRadius: 4,
            backgroundColor: COLORS.yellow,
          }}
        />

        {/* ----------------------------------- palm silhouette over the sun */}
        <div
          style={{
            position: "absolute",
            left: 1096,
            top: 180,
            width: 16,
            height: 214,
            borderRadius: 8,
            backgroundColor: TINTS.greenDeep,
            transform: "rotate(6deg)",
          }}
        />
        {frond(1004, 154, -150)}
        {frond(1036, 130, -105)}
        {frond(1075, 135, -60)}
        {frond(1099, 167, -15)}
        {frond(999, 167, 15)}
        <div
          style={{
            position: "absolute",
            left: 1086,
            top: 190,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: TINTS.greenDeep,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 1104,
            top: 198,
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: TINTS.greenDeep,
          }}
        />

        {/* --------------------------------------------- matchbox borders */}
        <div
          style={{
            position: "absolute",
            top: 22,
            left: 22,
            right: 22,
            bottom: 22,
            border: `6px solid ${COLORS.red}`,
            borderRadius: 12,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 38,
            left: 38,
            right: 38,
            bottom: 38,
            border: `2px solid ${COLORS.yellow}`,
            borderRadius: 6,
          }}
        />

        {/* -------------------------------------------------- strike strip */}
        <div
          style={{
            position: "absolute",
            left: 60,
            right: 60,
            bottom: 54,
            height: 8,
            display: "flex",
            overflow: "hidden",
          }}
        >
          {strikeDashes}
        </div>

        {/* -------------------------------------------------------- content */}
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            height: "100%",
            width: 820,
            paddingLeft: 88,
            paddingRight: 60,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                width: 36,
                height: 8,
                borderRadius: 4,
                marginRight: 14,
                backgroundColor: COLORS.red,
              }}
            />
            <div style={{ fontSize: 22, letterSpacing: 6, color: COLORS.yellow, fontWeight: 700 }}>
              {EVENT.studio}
            </div>
          </div>

          <div
            style={{
              fontFamily: "Rozha One",
              fontSize: 100,
              lineHeight: 1.1,
              color: COLORS.cream,
              marginTop: 12,
            }}
          >
            FrameInGoa
          </div>

          <div style={{ fontSize: 27, lineHeight: 1.35, color: TINTS.creamShadow, marginTop: 12 }}>
            One photo → a branded PFP frame + your Builder ID card.
          </div>

          <div style={{ display: "flex", alignItems: "center", marginTop: 34 }}>
            <div
              style={{
                display: "flex",
                backgroundColor: COLORS.red,
                color: COLORS.cream,
                fontSize: 24,
                fontWeight: 700,
                letterSpacing: 1,
                padding: "12px 20px",
                borderRadius: 6,
                marginRight: 14,
              }}
            >
              {EVENT.hashtag}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                backgroundColor: COLORS.yellow,
                color: COLORS.ink,
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: 2,
                padding: "12px 18px",
                borderRadius: 6,
              }}
            >
              <div style={{ display: "flex" }}>{EVENT.wordmarkLatin}</div>
              {/* Devanagari lives in its own element with its own family: the
                  Rozha latin subset has no matras, so mixing scripts inside one
                  text node would render tofu. */}
              <div style={{ display: "flex", fontFamily: "Yatra One", fontSize: 25, marginLeft: 10 }}>
                {EVENT.wordmarkDevanagari}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 19, letterSpacing: 3, color: "rgba(255,243,220,0.72)", marginTop: 26 }}>
            {EVENT.dates}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Rozha One", data: rozha, weight: 400, style: "normal" },
        { name: "Yatra One", data: yatra, weight: 400, style: "normal" },
        { name: "Space Grotesk", data: grotesk400, weight: 400, style: "normal" },
        { name: "Space Grotesk", data: grotesk700, weight: 700, style: "normal" },
      ],
    },
  );
}
