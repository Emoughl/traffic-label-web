import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { trashFiles } from "@/lib/drive";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { fileIds } = await request.json();
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return NextResponse.json({ error: "fileIds required" }, { status: 400 });
  }

  await trashFiles(fileIds);
  return NextResponse.json({ ok: true, deleted: fileIds.length });
}
