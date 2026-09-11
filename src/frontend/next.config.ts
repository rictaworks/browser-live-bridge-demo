import type { NextConfig } from "next";

// 本番（Vercel）はNEXT_PUBLIC_BACKEND_URLで別オリジン（Railway）のRailsへ直接
// credentials: "include"付きでfetchする構成であり、これ自体は変更しない
// （backend側のCookieはsame_site: :none + secure: trueで、HTTPS同士のため成立する）。
//
// 一方、開発環境（docker compose）はfrontend:3000 / backend:3001が別オリジンかつ
// HTTPのため、モダンブラウザの仕様上「SameSite=NoneのCookieはSecure属性が
// 無いと保存されない」制約に抵触し、Cookie自体が保存されずセッションが
// 一切継続しない（毎リクエストでsession_idが変わり、配信ロックのハートビートが
// 常に404 = lock_lostになる。Issue #32で実機確認済み）。
//
// 開発環境限定でBACKEND_INTERNAL_URL（Next.jsサーバー側のみが参照する非公開の
// 環境変数。docker composeのサービス名解決でbackendコンテナへ到達する）が
// 設定されている場合のみ、/api/**をNext.jsのrewriteでサーバー側プロキシし、
// ブラウザからは常に同一オリジン（http://localhost:3000/api/**）として見せる。
// これによりCookieはホストオンリー・same-siteとして扱われ、same_site: :none
// 自体の可否に関係なく保存・送信されるようになる。本番ビルドでは
// BACKEND_INTERNAL_URLを設定しないため、このrewriteは一切追加されない。
const nextConfig: NextConfig = {
  async rewrites() {
    const backendInternalUrl = process.env.BACKEND_INTERNAL_URL;
    if (!backendInternalUrl) {
      return [];
    }
    return [
      {
        source: "/api/:path*",
        destination: `${backendInternalUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
