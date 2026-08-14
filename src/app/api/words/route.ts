import { NextResponse, type NextRequest } from "next/server";
import {
  fetchSheet,
  type SheetError,
  type SheetParseResult,
} from "@/lib/sheet";

type WordsResponse = SheetParseResult | { error: SheetError };

const statusByErrorCode: Record<SheetError["code"], number> = {
  SHEET_CSV_URL_MISSING: 500,
  SHEET_CSV_URL_INVALID: 500,
  SHEET_NOT_PUBLISHED: 502,
  SHEET_UNREACHABLE: 502,
};

export async function GET(
  request: NextRequest,
): Promise<NextResponse<WordsResponse>> {
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const result = await fetchSheet({ fresh });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: statusByErrorCode[result.error.code] },
    );
  }

  return NextResponse.json(result.sheet);
}
