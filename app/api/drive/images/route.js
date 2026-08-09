import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { findFolderIdByDate, listImagesInFolder, invalidateCachesForDate } from "@/lib/drive";
import { getLabeledFilenames } from "@/lib/sheets";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date");
    if (!date) {
      return NextResponse.json({ error: "missing date" }, { status: 400 });
    }

    const force = searchParams.get("force");
    if (force === "1" || force === "true") {
      await invalidateCachesForDate(date);
    }

    const folderId = await findFolderIdByDate(date);
    if (!folderId) {
      return NextResponse.json({ error: "folder not found" }, { status: 404 });
    }

    const [images, labeled] = await Promise.all([
      listImagesInFolder(folderId),
      getLabeledFilenames(date),
    ]);

    return NextResponse.json({
      images: images.map((i) => ({ id: i.id, name: i.name })),
      labeled: Array.from(labeled),
    });
  } catch (err) {
    console.error("/api/drive/images error:", err);
    return NextResponse.json(
      { error: err?.message || String(err) || "unknown error" },
      { status: 500 }
    );
  }
}
