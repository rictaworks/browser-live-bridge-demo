require_relative "boot"

require "rails"
# Pick the frameworks you want:
require "active_model/railtie"
require "active_job/railtie"
require "active_record/railtie"
require "active_storage/engine"
require "action_controller/railtie"
require "action_mailer/railtie"
require "action_mailbox/engine"
require "action_text/engine"
require "action_view/railtie"
require "action_cable/engine"
# require "rails/test_unit/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module App
  class Application < Rails::Application
    # Initialize configuration defaults for originally generated Rails version.
    config.load_defaults 8.1

    # Please, add to the `ignore` list any other `lib` subdirectories that do
    # not contain `.rb` files, or that should not be reloaded or eager loaded.
    # Common ones are `templates`, `generators`, or `middleware`, for example.
    config.autoload_lib(ignore: %w[assets tasks])

    # Configuration for the application, engines, and railties goes here.
    #
    # These settings can be overridden in specific environments using the files
    # in config/environments, which are processed later.
    #
    # config.time_zone = "Central Time (US & Canada)"
    # config.eager_load_paths << Rails.root.join("extras")

    # Only loads a smaller set of middleware suitable for API only apps.
    # Middleware like session, flash, cookies can be added back manually.
    # Skip views, helpers and assets when generating a new resource.
    config.api_only = true

    # セッションキーをCookie（httponly）に保持するため、
    # API-onlyモードでは含まれないCookie・セッションのミドルウェアを明示的に有効化する
    # （requirements.md 9節・21節、CLAUDE.md「認証・認可を設計に組み込まない」）。
    # 発行するのはセッションキーのみで、認証状態は一切保持しない。
    #
    # フロントエンド（Vercel）とアプリケーション層（Railway）は本番では別オリジンに
    # なるため、same_site: :lax ではクロスサイトfetchにCookieが付与されず、
    # 作成直後のリクエスト以外がすべて404（session_idが毎回変わり所有権スコープに
    # 一致しなくなるため）になる。same_site: :none には secure 属性が必須（仕様上）。
    #
    # 開発環境（docker compose）はNext.js側のrewrite（next.config.ts）により
    # ブラウザからは常に同一オリジン（http://localhost:3000/api/**）として見える
    # ため、same_site: :none自体が不要かつ有害。モダンブラウザは「SameSite=None
    # のCookieはSecure属性が無いと保存しない」仕様を持ち、HTTPかHTTPSかに関わらず
    # secure: falseのSameSite=NoneはCookie自体が保存されなかった（Issue #32で
    # 実機確認：作成直後のリクエストも含め毎回新規session_idが発行され続けた）。
    # 同一オリジンならsame_site: :lax（デフォルト挙動）で十分に成立するため、
    # 本番（別オリジン・HTTPS）のみsame_site: :none + secureを使う。
    config.session_store :cookie_store,
      key: "_browser_live_bridge_demo_session",
      same_site: Rails.env.production? ? :none : :lax,
      secure: Rails.env.production?
    config.middleware.use ActionDispatch::Cookies
    config.middleware.use config.session_store, config.session_options
  end
end
