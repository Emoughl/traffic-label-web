import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { findFolderIdByDate, listImagesInFolder, invalidateCachesForDate } from "@/lib/drive";
import { getLabeledFilenames, getDeletedFilenames, getDensityLabels } from "@/lib/sheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

    const [images, labeled, deleted, labelInfo] = await Promise.all([
      listImagesInFolder(folderId),
      getLabeledFilenames(date).catch(() => new Set()),
      getDeletedFilenames(date).catch(() => new Set()),
      getDensityLabels(date).catch(() => ({})),
    ]);

    // Lọc bỏ những ảnh đã bị đánh dấu DELETED
    const activeImages = images.filter((img) => !deleted.has(img.name));

    return NextResponse.json({
      images: activeImages.map((i) => ({
        id: i.id,
        name: i.name,
        // URL thumbnail trực tiếp từ Google CDN (không proxy qua server)
        thumbnailUrl: i.thumbnailLink
          ? i.thumbnailLink.replace(/=s\d+$/, "=s200")
          : null,
      })),
      labeled: Array.from(labeled).filter((name) => !deleted.has(name)),
      // { filename: { labelId, labelName, note } } — để client tô sáng nhãn đang có
      labels: Object.fromEntries(
        Object.entries(labelInfo).filter(([name]) => !deleted.has(name))
      ),
    });
  } catch (err) {
    console.error("/api/drive/images error:", err);
    return NextResponse.json(
      { error: err?.message || String(err) || "unknown error" },
      { status: 500 }
    );
  }
}
