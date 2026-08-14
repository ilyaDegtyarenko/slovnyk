import type { MetadataRoute } from "next";

// The colour the icons were drawn on. The `themeColor` in the root layout repeats it, and
// the two have to stay the same or the splash screen shows a seam around the icon.
const BRAND_COLOR = "#101014";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // The identity the browser keeps an installed app under, pinned so that a later change
    // to `start_url` cannot turn an update into a second, unrelated app.
    id: "/",
    name: "slovnyk",
    short_name: "slovnyk",
    description:
      "Spaced-repetition vocabulary practice from a word list a tutor keeps in a Google Sheet.",
    start_url: "/",
    display: "standalone",
    background_color: BRAND_COLOR,
    theme_color: BRAND_COLOR,
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // Android crops icons to its own shape, so the same artwork is shipped a second time
      // with the padding that survives the crop.
      {
        src: "/icons/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
