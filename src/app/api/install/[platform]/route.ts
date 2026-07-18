import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/install/[platform]
 *
 * Redirects the user to the latest GitHub Release asset for the requested
 * platform. The user never sees github.com in the page source — they only
 * see /api/install/windows etc. GitHub Releases does the actual file hosting
 * (free, supports large files, integrates with our CI/CD).
 *
 * Stable URLs work because all release assets use version-less filenames
 * (configured in desktop/package.json → artifactName: "TalkingCharactersStudio-Setup.${ext}").
 *
 * Supported platforms:
 *   - windows-setup   → TalkingCharactersStudio-Setup.exe (NSIS installer, RECOMMENDED)
 *   - windows-portable → TalkingCharactersStudio-Portable.exe (portable, no installer)
 *   - windows-zip      → TalkingCharactersStudio-windows.zip (zip of unpacked dir)
 *   - mac              → TalkingCharactersStudio.dmg (macOS)
 *   - linux            → TalkingCharactersStudio.AppImage (Linux)
 */

const GITHUB_RELEASE_BASE =
  "https://github.com/mohamedelnoss89/talking-characters-studio/releases/latest/download";

const ASSETS: Record<string, { url: string; fallback?: string; label: string }> = {
  "windows-setup": {
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio-Setup.exe`,
    label: "Windows Setup (NSIS Installer)",
  },
  "windows-portable": {
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio-Portable.exe`,
    label: "Windows Portable",
  },
  "windows-zip": {
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio-windows.zip`,
    label: "Windows ZIP",
  },
  mac: {
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio.dmg`,
    label: "macOS DMG",
  },
  linux: {
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio.AppImage`,
    label: "Linux AppImage",
  },
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  // In Next.js 15+ / 16, dynamic route params are async (Promise).
  // We must await them before reading properties.
  const { platform: rawPlatform } = await params;
  const platform = rawPlatform?.toLowerCase();
  const asset = ASSETS[platform];

  if (!asset) {
    return NextResponse.json(
      {
        error: "Unknown platform",
        supported: Object.keys(ASSETS),
      },
      { status: 404 }
    );
  }

  // Use a 302 redirect so the browser downloads the file directly.
  // The Location header points to GitHub's CDN (objects.githubusercontent.com),
  // which is what actually serves the bytes.
  const response = NextResponse.redirect(asset.url, 302);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

// Always run dynamically — the redirect target is fixed but we don't want
// any caching layer (Vercel CDN or browser) to memoize a stale URL.
export const dynamic = "force-dynamic";
