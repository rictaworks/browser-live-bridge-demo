# Be sure to restart your server when you modify this file.

# フロントエンド（Next.js、別オリジン）がCookieセッション（credentials: "include"）付きで
# /api/**を呼ぶ構成のため、CORSを有効化する（requirements.md 9節、issue #4）。
# 許可オリジンはFRONTEND_ORIGINで明示指定する（credentials併用時は "*" を指定できない）。
# 未設定時は開発環境（docker compose）のフロントエンドオリジンを既定値とする。
Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins ENV.fetch("FRONTEND_ORIGIN", "http://localhost:3000")

    resource "/api/*",
      headers: :any,
      methods: [ :get, :post, :put, :patch, :delete, :options ],
      credentials: true
  end
end
