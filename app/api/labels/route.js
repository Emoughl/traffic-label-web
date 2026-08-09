import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { appendLabelRows } from "@/lib/sheets";

export async function POST(request) {
  const session = await getServerSession(authOptions);

  const { date, items, labeledBy } = await request.json();
  if (!date || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const author = session?.user?.email || (labeledBy && String(labeledBy).trim()) || "";
  if (!author) {
    return NextResponse.json({ error: "missing labeledBy (user not authenticated)" }, { status: 400 });
  }

  const rows = items.map((it) => [
    it.filename,
    it.labelId,
    it.labelName,
    it.note || "",
    it.fileId ? `https://drive.google.com/file/d/${it.fileId}/view` : "",
    author,
  ]);

  await appendLabelRows(date, rows);
  return NextResponse.json({ ok: true, count: rows.length });
}