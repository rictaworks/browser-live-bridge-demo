import { NextResponse } from "next/server";

// フロントエンド（Next.js）のヘルスチェック用エンドポイントです。
// ビジネスロジックは持たず、稼働確認用の固定レスポンスのみを返します。
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
