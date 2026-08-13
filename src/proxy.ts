import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.LEDGERLINES_AUTH_MODE === "google" &&
    !request.headers.has("x-ms-client-principal")
  ) {
    const destination = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const loginUrl = new URL("/.auth/login/google", request.url);
    loginUrl.searchParams.set("post_login_redirect_uri", destination);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/songs/:path*",
    "/record/:path*",
    "/coach/:path*",
    "/progress/:path*",
    "/share/:path*",
    "/takes/:path*",
  ],
};
