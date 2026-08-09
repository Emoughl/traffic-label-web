import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { listDateFolders, listImagesInFolder } from "@/lib/drive";
import { getLabeledFilenames } from "@/lib/sheets";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const folders = await listDateFolders();

  const withCounts = await Promise.all(
    folders.map(async (f) => {
      const [images, labeled] = await Promise.all([
        listImagesInFolder(f.id),
        getLabeledFilenames(f.name).catch(() => new Set()),
      ]);
      const labeledCount = images.filter((i) => labeled.has(i.name)).length;
      return { id: f.id, name: f.name, total: images.length, labeledCount };
    })
  );

  return NextResponse.json({ folders: withCounts });
}
