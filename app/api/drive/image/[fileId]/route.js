import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { getFileBytes } from "@/lib/drive";

export async function GET(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { fileId } = params;
  try {
    const { data, mimeType } = await getFileBytes(fileId);
    return new NextResponse(Buffer.from(data), {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
