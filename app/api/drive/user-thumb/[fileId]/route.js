import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getDriveClientForUser } from "@/lib/googleAuth";

export const runtime = "nodejs";

/** Proxy thumbnail bằng token của người đăng nhập — dùng cho ảnh đã chuyển sang
 * folder backup mà service account không còn quyền đọc. */
export async function GET(request, { params }) {
  const jwt = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  const drive = getDriveClientForUser(jwt?.accessToken);
  if (!drive) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const meta = await drive.files.get({
      fileId: params.fileId,
      fields: "thumbnailLink",
      supportsAllDrives: true,
    });
    const url = meta.data.thumbnailLink?.replace(/=s\d+$/, "=s400");
    if (url) {
      const res = await fetch(url);
      if (res.ok) {
        return new NextResponse(Buffer.from(await res.arrayBuffer()), {
          headers: {
            "Content-Type": res.headers.get("content-type") || "image/jpeg",
            "Cache-Control": "private, max-age=3600",
          },
        });
      }
    }
    // Không có thumbnail → tải thẳng file
    const media = await drive.files.get(
      { fileId: params.fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return new NextResponse(Buffer.from(media.data), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
}
