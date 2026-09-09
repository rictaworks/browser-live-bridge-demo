# アプリケーション層（Rails）のヘルスチェック用コントローラーです。
# ビジネスロジックは持たず、稼働確認用の固定レスポンスのみを返します。
class HealthController < ApplicationController
  def show
    render json: { status: "ok" }
  end
end
