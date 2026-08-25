import GoogleProvider from "next-auth/providers/google";

// Cần scope này để app thay mặt người đăng nhập di chuyển ảnh trên Drive.
// (Service account chỉ có quyền Xem nên không move được.)
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Xin access token mới từ refresh token khi token cũ hết hạn (~1 giờ). */
async function refreshAccessToken(token) {
  try {
    if (!token.refreshToken) throw new Error("không có refresh_token");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || "refresh failed");
    return {
      ...token,
      accessToken: data.access_token,
      accessTokenExpires: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      refreshToken: data.refresh_token || token.refreshToken,
      error: undefined,
    };
  } catch (err) {
    console.error("[auth] Không refresh được access token:", err.message);
    return { ...token, accessToken: undefined, error: "RefreshAccessTokenError" };
  }
}

export const authOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      authorization: {
        params: {
          scope: `openid email profile ${DRIVE_SCOPE}`,
          access_type: "offline", // để nhận refresh_token
          prompt: "consent", // buộc Google phát lại refresh_token
        },
      },
    }),
  ],
  pages: {
    signIn: "/signin",
  },
  session: { strategy: "jwt" },
  callbacks: {
    async session({ session, token }) {
      if (token?.email && session?.user) {
        session.user.email = token.email;
      }
      if (session?.user) {
        // Chỉ báo trạng thái, KHÔNG gửi access token về trình duyệt
        session.user.driveWritable = Boolean(token?.accessToken) && !token?.error;
      }
      return session;
    },
    async jwt({ token, user, account }) {
      if (user?.email) {
        token.email = user.email;
      }
      // Lần đăng nhập đầu: lưu token của Google
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token || token.refreshToken,
          accessTokenExpires: account.expires_at
            ? account.expires_at * 1000
            : Date.now() + 3600 * 1000,
          scope: account.scope,
          error: undefined,
        };
      }
      // Còn hạn (trừ hao 60s) → dùng tiếp
      if (token.accessTokenExpires && Date.now() < token.accessTokenExpires - 60_000) {
        return token;
      }
      if (!token.refreshToken) return token;
      return refreshAccessToken(token);
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      else if (new URL(url).origin === baseUrl) return url;
      return baseUrl;
    },
  },
};
