import { NextResponse } from "next/server";
import { authOptions } from "@/lib/authOptions";
import { getServerSession } from "next-auth/next";
import { getFileThumbnailBytes } from "@/lib/drive";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { fileId } = params;
  try {
    const { data, mimeType } = await getFileThumbnailBytes(fileId);
    return new NextResponse(Buffer.from(data), {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: "thumbnail not found" }, { status: 404 });
  }
}
