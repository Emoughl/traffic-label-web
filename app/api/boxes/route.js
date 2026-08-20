import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import {
  getVehicleBoxes,
  getBoxConfirmedFilenames,
  saveVehicleBoxes,
} from "@/lib/sheets";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "missing date" }, { status: 400 });
  }

  const [boxes, confirmed] = await Promise.all([
    getVehicleBoxes(date),
    getBoxConfirmedFilenames(date),
  ]);

  return NextResponse.json({ boxes, confirmed: Array.from(confirmed) });
}

export async function POST(request) {
  const session = await getServerSession(authOptions);

  const { date, filename, fileId, boxes, labeledBy } = await request.json();
  if (!date || !filename || !Array.isArray(boxes)) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const author = session?.user?.email || (labeledBy && String(labeledBy).trim()) || "";
  if (!author) {
    return NextResponse.json({ error: "missing labeledBy (user not authenticated)" }, { status: 400 });
  }

  await saveVehicleBoxes(date, filename, fileId, boxes, author);
  return NextResponse.json({ ok: true, count: boxes.length });
}